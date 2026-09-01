import Fastify from "fastify";
import { execFile, spawn } from "node:child_process";
import {
  writeFile,
  mkdir,
  rm,
  readFile,
  stat,
  cp,
  readdir,
  utimes,
} from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { UUID_RE, resolvePreviewSource } from "./preview-source.mjs";
import { createRenderSlots } from "./render-slots.mjs";
import {
  shouldSweepJob,
  isJobDir,
  DEFAULT_ERROR_RETENTION_MS,
  DEFAULT_DONE_RETENTION_MS,
} from "./job-retention.mjs";
import { createOrphanJanitor } from "./orphan-scan.mjs";
import { settleOnExit, DEFAULT_DRAIN_MS } from "./child-outcome.mjs";
import { createIdleWatchdog, DEFAULT_IDLE_MS } from "./idle-watchdog.mjs";

// Binário local do hyperframes — evita que o npx baixe o pacote a cada chamada
const HF_BIN = fileURLToPath(
  new URL("./node_modules/.bin/hyperframes", import.meta.url),
);
const PORT = 3030;
const HOST = "0.0.0.0";
const WORK_DIR = "/tmp/hf-jobs";
const PREVIEW_DIR = "/tmp/hf-previews";

// Nº de workers do render. O `auto` do hyperframes calibra a frio e tende a escolher
// 1 worker mesmo quando a captura em regime é rápida. Em ARM (modo screenshot) compensa
// fixar conforme os cores disponíveis. Ajuste via env RENDER_WORKERS.
const RENDER_WORKERS = process.env.RENDER_WORKERS ?? "auto";

// TTL dos previews em ms (padrão: 12 horas). Ajustável via env PREVIEW_TTL_MS.
const PREVIEW_TTL_MS = parseInt(
  process.env.PREVIEW_TTL_MS ?? String(12 * 60 * 60 * 1000),
);

// Porta dedicada ao studio hyperframes preview.
// Deve ser exposta no docker-compose e acessível de fora do container.
// PUBLIC_PREVIEW_URL é a URL base pública para o browser acessar essa porta.
// Ex: PUBLIC_PREVIEW_URL=http://seu-host:3031
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT ?? "3031");
const PUBLIC_PREVIEW_URL = (
  process.env.PUBLIC_PREVIEW_URL ?? `http://localhost:${PREVIEW_PORT}`
).replace(/\/$/, "");

// URL pública desta porta (PORT/3030), por onde a Studio é servida via proxy.
// É o que resolve o bug de save: proxiando a Studio por aqui o servidor consegue
// injetar o polyfill de secure context no HTML dela (ver studio-polyfill.js).
// Enquanto NÃO estiver definida, `preview_url` continua apontando para a 3031
// exatamente como antes — a migração é opt-in. Ex: PUBLIC_BASE_URL=http://seu-host:3030
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

// Desliga o proxy da Studio sem precisar de deploy de código (rollback por env var).
const STUDIO_PROXY_ENABLED = process.env.STUDIO_PROXY !== "false";

// Servidor MCP de autoria em /mcp — dá a um agente de IA acesso ao contrato de
// composição e ao catálogo de templates do HyperFrames. Desligável por env var.
const MCP_ENABLED = process.env.MCP_ENABLED !== "false";

// Por quanto tempo os arquivos de um preview sobrevivem depois que o processo morre.
// Precisam sobreviver para que `POST /render {preview_id}` renderize as edições que
// foram salvas na Studio. Padrão: 24 horas.
const PREVIEW_RETENTION_MS = parseInt(
  process.env.PREVIEW_RETENTION_MS ?? String(24 * 60 * 60 * 1000),
);

// Reabertura da Studio sobre um diretório de preview que ainda está em disco
// (`POST /preview {preview_id}`). Kill-switch: PREVIEW_REOPEN=false devolve o
// contrato antigo (só `html`) sem deploy de código.
const PREVIEW_REOPEN_ENABLED = process.env.PREVIEW_REOPEN !== "false";

// ─── Guardas de estabilidade do render ───────────────────────────────────────
// Todas ligadas por padrão, cada uma com kill-switch por env var: o rollback é
// mudar a variável e reiniciar, sem deploy de código.

// Teto de renders simultâneos. Cada render sobe RENDER_WORKERS Chromiums; dois em
// paralelo numa VPS pequena não dão dois renders lentos, dão dois timeouts.
// MAX_CONCURRENT_RENDERS=0 desliga a guarda (comportamento anterior).
const MAX_CONCURRENT_RENDERS = parseInt(
  process.env.MAX_CONCURRENT_RENDERS ?? "1",
);

// Timeout do render. Era fixo em 10 min dentro das opções do execFile.
const RENDER_TIMEOUT_MS = parseInt(
  process.env.RENDER_TIMEOUT_MS ?? String(10 * 60 * 1000),
);

// Timeout do POST /check, que também abre browser real. Era fixo em 60s.
const CHECK_TIMEOUT_MS = parseInt(process.env.CHECK_TIMEOUT_MS ?? "60000");

// Graça entre o SIGTERM e o SIGKILL no grupo de processos.
const RENDER_KILL_GRACE_MS = 5_000;

// Janela para o stdout/stderr drenarem depois que o CLI sai. Ver child-outcome.mjs:
// o desfecho vem do `exit`, e esperar o `close` é o que prendia o job quando o CLI
// deixava um Chromium para trás segurando os pipes herdados.
const RENDER_DRAIN_MS = parseInt(
  process.env.RENDER_DRAIN_MS ?? String(DEFAULT_DRAIN_MS),
);

// Silêncio máximo de um render vivo. Ver idle-watchdog.mjs: o CLI do hyperframes
// imprime "Render failed" e NÃO sai — sem `exit`, o desfecho pelo exit não chega,
// e o job ficava preso até o RENDER_TIMEOUT_MS (1800s na VPS) segurando a vaga
// única. Um render que trabalha fala; um que desistiu fica calado para sempre.
// RENDER_IDLE_MS=0 desliga o freio e volta ao comportamento anterior.
const RENDER_IDLE_MS = parseInt(
  process.env.RENDER_IDLE_MS ?? String(DEFAULT_IDLE_MS),
);

// Mata o GRUPO de processos em vez de só o PID do CLI. O `timeout` do execFile
// sinaliza um PID; os workers Chromium, filhos dele, sobrevivem e são reparentados
// para o PID 1. KILL_PROCESS_GROUP=false volta ao comportamento antigo.
const KILL_PROCESS_GROUP = process.env.KILL_PROCESS_GROUP !== "false";

// Varredura dos diretórios de job. JOB_SWEEP=false desliga.
const JOB_SWEEP_ENABLED = process.env.JOB_SWEEP !== "false";
const JOB_ERROR_RETENTION_MS = parseInt(
  process.env.JOB_ERROR_RETENTION_MS ?? String(DEFAULT_ERROR_RETENTION_MS),
);
const JOB_DONE_RETENTION_MS = parseInt(
  process.env.JOB_DONE_RETENTION_MS ?? String(DEFAULT_DONE_RETENTION_MS),
);

// Varredura de Chromium órfão (ppid=1). CHROMIUM_JANITOR=false desliga.
const CHROMIUM_JANITOR_ENABLED = process.env.CHROMIUM_JANITOR !== "false";
const CHROMIUM_JANITOR_INTERVAL_MS = parseInt(
  process.env.CHROMIUM_JANITOR_INTERVAL_MS ?? String(10 * 60 * 1000),
);

const renderSlots = createRenderSlots({ max: MAX_CONCURRENT_RENDERS });

// Renders em andamento: jobId → processo. Alimenta três coisas — o `isActive` da
// varredura de jobs, o kill de grupo no shutdown, e o GET /health.
const activeRenders = new Map();

// Apenas um preview ativo por vez
let activePreview = null; // { proc, previewId, port, timer }

// URL pública da Studio servida por ESTA porta (com o polyfill injetado), ou null
// quando o proxy está desligado ou PUBLIC_BASE_URL não foi definida — caso em que
// o comportamento antigo (entregar a porta do studio direto) é preservado.
function studioProxyUrl() {
  if (!STUDIO_PROXY_ENABLED || !PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/`;
}

// URLs públicas do preview para a porta REAL do studio, que pode diferir de
// PREVIEW_PORT se houve conflito no spawn. `direct` é a porta do studio (sem o
// polyfill de secure context); `preview` é a proxiada por esta porta quando
// PUBLIC_BASE_URL está definida — a única em que salvar edições funciona fora
// de HTTPS/localhost. Sem PUBLIC_BASE_URL, `preview` cai em `direct`, que é
// exatamente o comportamento anterior ao proxy.
function publicPreviewUrls(port) {
  const basePublic = PUBLIC_PREVIEW_URL.replace(/:\d+$/, "");
  const direct =
    port === PREVIEW_PORT ? PUBLIC_PREVIEW_URL : `${basePublic}:${port}`;
  return { direct, preview: studioProxyUrl() ?? direct };
}

// Sinaliza o GRUPO de processos do filho, não só o PID dele.
//
// `proc.kill()` e o `timeout` do execFile mandam o sinal para um PID. O CLI do
// hyperframes spawna Chromiums como filhos: eles não recebem nada, ficam órfãos e
// são reparentados para o PID 1, onde seguem vivos consumindo CPU e shm até o
// container reiniciar. `kill(-pid)` alcança a árvore inteira.
//
// PRÉ-REQUISITO: o filho precisa ter sido criado com `spawn(..., { detached: true })`,
// que o torna líder de um grupo novo. **`execFile` NÃO serve** — ele repassa ao
// spawn apenas uma whitelist de opções (cwd, env, uid, gid, shell, signal,
// windowsHide, windowsVerbatimArguments) e descarta `detached` em silêncio. Sem
// grupo próprio, o filho herda o grupo do servidor e `kill(-pid)` falha com ESRCH
// — ou, pior, acertaria o próprio servidor se o pid coincidisse com o pgid dele.
// Por isso os três pontos que abrem browser (render, check, preview) usam spawn.
//
// Com KILL_PROCESS_GROUP=false, cai no kill de PID único de sempre.
function killTree(proc, signal = "SIGTERM") {
  if (!proc?.pid) return false;
  try {
    if (KILL_PROCESS_GROUP) process.kill(-proc.pid, signal);
    else proc.kill(signal);
    return true;
  } catch {
    // ESRCH: já morreu. Qualquer outro erro aqui não tem ação de recuperação.
    return false;
  }
}

// Opções de spawn que tornam o filho líder do próprio grupo de processos.
// Sem isso o `kill(-pid)` do killTree() falha com ESRCH.
const detachedOpts = () => (KILL_PROCESS_GROUP ? { detached: true } : {});

// Teto do log acumulado em memória por processo. Substitui o `maxBuffer` do
// execFile, que o spawn não tem: sem isso, um CLI verborrágico num render longo
// faz o log crescer sem limite. Corta o começo e mantém o fim, que é onde está o
// erro. 32MB é o mesmo valor que o maxBuffer usava.
const MAX_LOG_BYTES = 32 * 1024 * 1024;
function appendCapped(buffer, text) {
  const next = buffer + text;
  if (next.length <= MAX_LOG_BYTES) return next;
  return (
    "[... início do log truncado ...]\n" + next.slice(-(MAX_LOG_BYTES - 40))
  );
}

// Mata o processo ativo e limpa todos os studios registrados pelo hyperframes.
// NÃO apaga os arquivos: o que a Studio salvou em disco precisa sobreviver para
// que `POST /render {preview_id}` consiga renderizar as edições. A limpeza fica
// a cargo de sweepOldPreviews() (PREVIEW_RETENTION_MS) ou de um DELETE explícito
// com ?purge=true.
async function killActivePreview({ purge = false } = {}) {
  if (activePreview) {
    clearTimeout(activePreview.timer);
    // Grupo inteiro: a Studio também abre Chromium (thumbnails, captura de frame).
    killTree(activePreview.proc, "SIGTERM");
    if (purge) {
      rm(join(PREVIEW_DIR, activePreview.previewId), {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
    activePreview = null;
  }
  // Garante que o registry interno do hyperframes seja limpo antes do próximo preview
  await new Promise((resolve) => {
    execFile(HF_BIN, ["preview", "--kill-all"], { timeout: 10_000 }, () =>
      resolve(),
    );
  });
}

// Spawna hyperframes preview no diretório da composição.
// Parseia a porta real do stdout (pode diferir da solicitada se houver conflito).
function spawnPreview(dir, port) {
  return new Promise((resolve, reject) => {
    // spawn, não execFile: só ele aceita `detached`, e é isso que dá ao preview um
    // grupo próprio para o killTree() alcançar (a Studio também abre Chromium).
    // O stdout já era consumido à mão aqui, então nada se perde na troca.
    const proc = spawn(
      HF_BIN,
      ["preview", "--port", String(port), "--no-open", "--force-new"],
      { cwd: dir, ...detachedOpts() },
    );

    const readyTimeout = setTimeout(() => {
      killTree(proc);
      reject(new Error("hyperframes preview não iniciou em 30s"));
    }, 30_000);

    let resolved = false;
    const onChunk = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`[preview] ${text}`);

      if (resolved) return;

      // Parseia a porta real: "Studio    http://localhost:XXXX"
      const portMatch = text.match(/Studio\s+http:\/\/localhost:(\d+)/);
      if (portMatch) {
        resolved = true;
        clearTimeout(readyTimeout);
        resolve({ proc, actualPort: parseInt(portMatch[1]) });
        return;
      }

      // Fallback: qualquer menção ao localhost com porta
      const fallback = text.match(/http:\/\/localhost:(\d+)/);
      if (fallback && text.includes("Studio")) {
        resolved = true;
        clearTimeout(readyTimeout);
        resolve({ proc, actualPort: parseInt(fallback[1]) });
      }
    };

    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (err) => {
      clearTimeout(readyTimeout);
      reject(err);
    });
    proc.on("exit", (code) => {
      if (!resolved && code != null && code !== 0) {
        clearTimeout(readyTimeout);
        reject(new Error(`hyperframes preview saiu com código ${code}`));
      }
    });
  });
}

await mkdir(WORK_DIR, { recursive: true });
await mkdir(PREVIEW_DIR, { recursive: true });

// Remove diretórios de preview mais velhos que PREVIEW_RETENTION_MS. Como
// killActivePreview() deixou de apagá-los (para preservar as edições da Studio),
// esta é a única coisa que impede o volume hf_previews de crescer sem limite.
async function sweepOldPreviews() {
  const cutoff = Date.now() - PREVIEW_RETENTION_MS;
  let entries;
  try {
    entries = await readdir(PREVIEW_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    // Nunca remove o preview ativo, por mais velho que seja
    if (activePreview && entry === activePreview.previewId) continue;
    const dir = join(PREVIEW_DIR, entry);
    try {
      const info = await stat(dir);
      if (info.mtimeMs < cutoff) {
        await rm(dir, { recursive: true, force: true });
        app.log.info({ previewId: entry }, "Preview expirado removido");
      }
    } catch {}
  }
}

// Remove diretórios de job segundo a política de job-retention.mjs.
//
// Antes disso o único caminho de limpeza era o timer disparado quando o download
// COMEÇA: job que falhou, ou que ninguém baixou, ficava para sempre — com os
// frames PNG intermediários, vários GB por render longo. /tmp cheio faz o Chromium
// crashar com erros que não parecem falta de disco.
async function sweepOldJobs() {
  let entries;
  try {
    entries = await readdir(WORK_DIR);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    // lint-*/check-* já se limpam no finally dos handlers, e varrê-los durante uma
    // requisição síncrona apagaria o diretório debaixo do CLI em execução.
    if (!isJobDir(entry)) continue;

    const dir = join(WORK_DIR, entry);
    try {
      const info = await stat(dir);
      const { sweep, reason } = shouldSweepJob(
        {
          hasDone: existsSync(join(dir, "done.txt")),
          hasError: existsSync(join(dir, "error.txt")),
          ageMs: now - info.mtimeMs,
          isActive: activeRenders.has(entry),
        },
        {
          errorRetentionMs: JOB_ERROR_RETENTION_MS,
          doneRetentionMs: JOB_DONE_RETENTION_MS,
        },
      );
      if (sweep) {
        await rm(dir, { recursive: true, force: true });
        app.log.info({ jobId: entry, reason }, "Job expirado removido");
      }
    } catch {}
  }
}

// Varredura de Chromium órfão. Lê /proc de forma síncrona: são dezenas de arquivos
// minúsculos, o custo é irrelevante a cada 10 min, e a versão async complicaria o
// contrato do reader sem ganho.
const orphanJanitor = createOrphanJanitor({
  reader: {
    listPids: () => readdirSync("/proc").filter((p) => /^\d+$/.test(p)),
    readStat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
    readCmdline: (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8"),
  },
  kill: (pid) => {
    try {
      process.kill(Number(pid), "SIGKILL");
      return true;
    } catch {
      return false;
    }
  },
});

// Com o kill de grupo funcionando, este log deveria ficar VAZIO para sempre.
// Um warn aqui significa que algum caminho ainda solta filho — é sinal, não rotina.
function sweepOrphanChromiums() {
  let result;
  try {
    result = orphanJanitor.sweep();
  } catch (err) {
    // /proc não existe (macOS em dev, por exemplo) — o janitor simplesmente não faz nada.
    app.log.debug({ err: err.message }, "Varredura de órfãos indisponível");
    return;
  }
  for (const { pid, cmdline } of result.killed) {
    app.log.warn(
      { pid, cmdline: cmdline.slice(0, 120) },
      "Chromium órfão (ppid=1) morto pelo janitor — algum caminho não matou o grupo",
    );
  }
}

// Soma o tamanho dos arquivos de um diretório, um nível de recursão por vez.
// Só para diagnóstico do GET /preview — não vale a pena otimizar.
async function dirSize(dir) {
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) total += await dirSize(full);
      else total += (await stat(full)).size;
    }
  } catch {}
  return total;
}

// Rejeita paths absolutos ou que escapem do diretório de sessão via "..",
// para impedir escrita fora do previewDir/jobDir (path traversal).
function assertSafeRelativePath(path) {
  if (!path || isAbsolute(path) || path.split(/[/\\]/).includes("..")) {
    throw new Error(
      `Path inválido: "${path}" (não pode ser absoluto nem conter "..")`,
    );
  }
}

// Grava um asset no disco a partir de base64 ou de uma URL remota (bucket/CDN externo).
// URL evita o overhead de ~33% do base64 e o limite de tamanho do JSON body.
async function saveAsset(dir, asset) {
  assertSafeRelativePath(asset.filename);
  const dest = join(dir, asset.filename);
  await mkdir(dirname(dest), { recursive: true });
  if (asset.url) {
    const res = await fetch(asset.url);
    if (!res.ok) {
      throw new Error(
        `Falha ao baixar asset "${asset.filename}" de ${asset.url}: HTTP ${res.status}`,
      );
    }
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } else if (asset.base64) {
    await writeFile(dest, Buffer.from(asset.base64, "base64"));
  } else {
    throw new Error(`Asset "${asset.filename}" precisa de "base64" ou "url"`);
  }
}

// Grava o index.html da composição e, opcionalmente, arquivos de sub-composição
// (compositions/scene-N.html, resolvidos pelo runtime hyperframes via data-composition-src).
async function writeCompositionFiles(dir, html, compositions = []) {
  await writeFile(join(dir, "index.html"), html, "utf8");
  for (const composition of compositions) {
    assertSafeRelativePath(composition.path);
    const dest = join(dir, composition.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, composition.content, "utf8");
  }
}

const app = Fastify({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  },
});

// ─── Swagger docs em /docs ───────────────────────────────────────────────────
await app.register(import("@fastify/swagger"), {
  openapi: {
    info: {
      title: "HyperFrames Server",
      description:
        "API para renderização de vídeos com HyperFrames (Chromium + FFmpeg)",
      version: "1.0.0",
    },
  },
});

await app.register(import("@fastify/swagger-ui"), {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "full" },
  theme: {
    css: [{ filename: "theme.css", content: ".topbar { display: none }" }],
  },
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get(
  "/health",
  {
    schema: {
      summary: "Health check",
      response: {
        200: {
          type: "object",
          properties: {
            status: { type: "string" },
            uptime: { type: "number" },
            renders_in_flight: { type: "integer" },
            max_concurrent_renders: { type: "integer" },
          },
        },
      },
    },
  },
  // renders_in_flight expõe o estado do mutex: sem ele, um 429 do POST /render não
  // teria como ser distinguido de um bug pelo lado de fora.
  async () => ({
    status: "ok",
    uptime: process.uptime(),
    renders_in_flight: renderSlots.inFlight(),
    max_concurrent_renders: renderSlots.max(),
  }),
);

// ─── POST /preview ────────────────────────────────────────────────────────────
app.post(
  "/preview",
  {
    schema: {
      summary: "Cria (ou reabre) um preview ao vivo da composição",
      description:
        "Salva o HTML e assets no disco, spawna `hyperframes preview` e retorna " +
        `a URL proxiada pelo servidor. O processo expira em ${PREVIEW_TTL_MS / 3_600_000} horas.\n\n` +
        "Aceita a composição de duas formas mutuamente exclusivas: `html` (com os " +
        "opcionais `compositions`/`assets`), ou `preview_id` — que **reabre** a Studio " +
        "sobre o diretório de um preview que ainda está em disco, com as edições que " +
        "foram salvas nele. O id não muda.",
      body: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description:
              "Conteúdo do index.html da composição HyperFrames. Mutuamente exclusivo com preview_id.",
          },
          preview_id: {
            type: "string",
            description:
              "UUID de um preview ainda retido em disco (ver GET /preview). Reabre a Studio " +
              "sobre esse diretório, no lugar e com o mesmo id, preservando as edições salvas. " +
              "Mutuamente exclusivo com html.",
          },
          compositions: {
            type: "array",
            description:
              "Arquivos de sub-composição adicionais (ex: compositions/scene-1.html), usados junto " +
              "com data-composition-src no index.html para dividir a composição em múltiplos arquivos. " +
              "O runtime hyperframes resolve data-composition-src nativamente — o servidor só materializa " +
              "os arquivos no diretório de sessão antes de rodar o CLI.",
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: {
                  type: "string",
                  description:
                    "Caminho relativo ao diretório de sessão, ex: compositions/scene-1.html",
                },
                content: {
                  type: "string",
                  description:
                    "Conteúdo do arquivo (HTML com <template>, <style> e <script> da cena)",
                },
              },
            },
          },
          assets: {
            type: "array",
            description:
              'Arquivos adicionais (áudio, imagens). Cada item aceita "base64" OU "url" ' +
              "(asset já hospedado em bucket/CDN externo — evita o overhead do base64).",
            items: {
              type: "object",
              required: ["filename"],
              properties: {
                filename: { type: "string" },
                base64: {
                  type: "string",
                  description: "Conteúdo do arquivo em base64",
                },
                url: {
                  type: "string",
                  description: "URL pública/assinada de onde baixar o asset",
                },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: "object",
          properties: {
            preview_id: { type: "string" },
            preview_url: { type: "string" },
            preview_url_direct: { type: "string" },
            expires_in: { type: "string" },
            reused: {
              type: "boolean",
              description:
                "true quando a Studio foi reaberta sobre um diretório existente (preview_id), " +
                "false quando o preview foi criado do zero a partir de html",
            },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const {
      html,
      preview_id: previewIdParam,
      compositions = [],
      assets = [],
    } = req.body;

    // O previewId vem do cliente e vira path — só consulta o disco depois de
    // validado contra o formato exato de randomUUID(), que barra traversal.
    const source = resolvePreviewSource({
      html,
      previewId: previewIdParam,
      hasExtras: compositions.length > 0 || assets.length > 0,
      previewDirExists:
        previewIdParam && UUID_RE.test(previewIdParam)
          ? existsSync(join(PREVIEW_DIR, previewIdParam))
          : false,
      reopenEnabled: PREVIEW_REOPEN_ENABLED,
    });
    if (!source.ok) {
      return reply.code(source.status).send({ error: source.error });
    }
    const reused = source.mode === "reuse";

    // A Studio usa globalThis.crypto.randomUUID/crypto.subtle ao salvar edições, e o
    // navegador só expõe essas APIs em secure context (HTTPS ou localhost). Servir em
    // HTTP puro fora de localhost quebra todo save. O proxy desta porta injeta o
    // polyfill que cobre isso — mas só quem abrir a Studio POR AQUI fica protegido.
    if (!studioProxyUrl()) {
      app.log.warn(
        { publicPreviewUrl: PUBLIC_PREVIEW_URL },
        "Studio sendo servida direto pela porta do preview, sem o proxy desta porta: se a " +
          "URL não for HTTPS nem localhost, o save vai falhar (crypto.randomUUID/crypto.subtle " +
          "indisponíveis fora de secure context). Defina PUBLIC_BASE_URL para servir a Studio " +
          "por esta porta com o polyfill injetado.",
      );
    }

    // Reabrir o preview que JÁ está ativo é no-op: derrubar e respawnar a Studio
    // embaixo de quem estiver com ela aberta seria pior que não fazer nada. Só o
    // TTL é renovado, para que o `expires_in` devolvido continue verdadeiro.
    if (reused && activePreview?.previewId === previewIdParam) {
      clearTimeout(activePreview.timer);
      activePreview.timer = setTimeout(
        () => killActivePreview(),
        PREVIEW_TTL_MS,
      );
      const urls = publicPreviewUrls(activePreview.port);
      app.log.info(
        { previewId: previewIdParam },
        "Preview já estava ativo — devolvido sem respawn (TTL renovado)",
      );
      return reply.code(201).send({
        preview_id: previewIdParam,
        preview_url: urls.preview,
        preview_url_direct: urls.direct,
        expires_in: `${PREVIEW_TTL_MS / 3_600_000} horas`,
        reused: true,
      });
    }

    // Encerra qualquer preview anterior e limpa o registry do hyperframes
    await killActivePreview();

    const previewId = reused ? previewIdParam : randomUUID();
    const previewDir = join(PREVIEW_DIR, previewId);

    if (reused) {
      // Segura a retenção: sweepOldPreviews() só poupa o preview ATIVO, então um
      // diretório reaberto já perto das 24h seria varrido na passada seguinte —
      // levando junto as edições feitas nesta sessão.
      await utimes(previewDir, new Date(), new Date()).catch(() => {});
    } else {
      await mkdir(previewDir, { recursive: true });
      try {
        await writeCompositionFiles(previewDir, html, compositions);
        for (const asset of assets) {
          await saveAsset(previewDir, asset);
        }
      } catch (err) {
        await rm(previewDir, { recursive: true, force: true });
        return reply.code(400).send({ error: err.message });
      }
    }

    let proc, actualPort;
    try {
      ({ proc, actualPort } = await spawnPreview(previewDir, PREVIEW_PORT));
    } catch (err) {
      // Apagar só o que este request criou. No reuso o diretório é preexistente:
      // uma falha de spawn não pode levar embora as edições salvas nele.
      if (!reused) await rm(previewDir, { recursive: true, force: true });
      return reply.code(500).send({ error: err.message });
    }

    const { direct: directUrl, preview: previewUrl } =
      publicPreviewUrls(actualPort);

    const timer = setTimeout(() => killActivePreview(), PREVIEW_TTL_MS);
    activePreview = { proc, previewId, port: actualPort, timer };

    // Se o processo da Studio morrer sozinho (crash, OOM, kill externo), nada
    // limparia activePreview e o proxy seguiria roteando para uma porta morta —
    // toda requisição a /, /api/* etc. ficaria pendurada até estourar. Este
    // handler devolve o servidor ao estado "sem preview ativo", em que o proxy
    // responde 503 acionável na hora.
    proc.on("exit", (code, signal) => {
      if (activePreview?.proc !== proc) return; // já foi substituído/encerrado
      clearTimeout(activePreview.timer);
      activePreview = null;
      app.log.warn(
        { previewId, code, signal },
        "Processo da Studio terminou sozinho — preview ativo liberado",
      );
    });

    app.log.info(
      { previewId, port: actualPort, reused },
      reused ? "Preview reaberto" : "Preview started",
    );

    reply.code(201).send({
      preview_id: previewId,
      preview_url: previewUrl,
      preview_url_direct: directUrl,
      expires_in: `${PREVIEW_TTL_MS / 3_600_000} horas`,
      reused,
    });
  },
);

// ─── GET /preview ─────────────────────────────────────────────────────────────
// Estado do preview: qual está ativo e o que sobrou em disco. Sem isso não havia
// como descobrir o preview_id ativo — e o DELETE exige ele — nem saber quais
// preview_id ainda dão para renderizar.
app.get(
  "/preview",
  {
    schema: {
      summary: "Estado do preview ativo e dos diretórios retidos",
      description:
        "Retorna o preview ativo (se houver) e a lista de diretórios de preview em disco, " +
        "com idade e tamanho. Um preview_id listado aqui ainda pode ser renderizado via " +
        "POST /render, mesmo que o processo da Studio já tenha sido encerrado.",
      response: {
        200: {
          type: "object",
          properties: {
            active: {
              type: "object",
              nullable: true,
              properties: {
                preview_id: { type: "string" },
                port: { type: "integer" },
                preview_url: { type: "string" },
              },
            },
            retention_hours: { type: "number" },
            stored: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  preview_id: { type: "string" },
                  age_hours: { type: "number" },
                  size_bytes: { type: "integer" },
                  renderable: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },
  async () => {
    let entries = [];
    try {
      entries = await readdir(PREVIEW_DIR);
    } catch {}

    const stored = [];
    for (const entry of entries) {
      if (!UUID_RE.test(entry)) continue;
      try {
        const info = await stat(join(PREVIEW_DIR, entry));
        stored.push({
          preview_id: entry,
          age_hours:
            Math.round(((Date.now() - info.mtimeMs) / 3_600_000) * 10) / 10,
          size_bytes: await dirSize(join(PREVIEW_DIR, entry)),
          renderable: true,
        });
      } catch {}
    }
    stored.sort((a, b) => a.age_hours - b.age_hours);

    return {
      active: activePreview
        ? {
            preview_id: activePreview.previewId,
            port: activePreview.port,
            preview_url: studioProxyUrl() ?? PUBLIC_PREVIEW_URL,
          }
        : null,
      retention_hours: PREVIEW_RETENTION_MS / 3_600_000,
      stored,
    };
  },
);

// ─── DELETE /preview/:previewId ───────────────────────────────────────────────
app.delete(
  "/preview/:previewId",
  {
    schema: {
      summary: "Encerra o preview ativo",
      description:
        "Encerra o processo do studio e libera a porta. Por padrão os arquivos do " +
        "preview são MANTIDOS em disco, para que `POST /render {preview_id}` ainda " +
        "consiga renderizar as edições salvas na Studio. Use ?purge=true para apagá-los " +
        "também; caso contrário são removidos pela retenção (PREVIEW_RETENTION_MS, 24h).",
      params: {
        type: "object",
        properties: { previewId: { type: "string" } },
      },
      querystring: {
        type: "object",
        properties: {
          purge: {
            type: "boolean",
            default: false,
            description:
              "Se true, apaga também os arquivos do preview (as edições salvas são perdidas)",
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            deleted: { type: "boolean" },
            purged: { type: "boolean" },
          },
        },
      },
    },
  },
  async (req, reply) => {
    if (!activePreview || activePreview.previewId !== req.params.previewId) {
      return reply.code(404).send({ error: "Preview não encontrado" });
    }
    const purge = req.query.purge === true;
    await killActivePreview({ purge });
    app.log.info({ previewId: req.params.previewId, purge }, "Preview deleted");
    return { deleted: true, purged: purge };
  },
);

// ─── POST /lint ───────────────────────────────────────────────────────────────
// Valida o HTML da composição sem renderizar. Síncrono e instantâneo.
// Use antes do /preview ou /render para capturar erros do agente de IA.
app.post(
  "/lint",
  {
    schema: {
      summary: "Valida uma composição HyperFrames sem renderizar",
      description:
        "Executa hyperframes lint no HTML fornecido. Síncrono — responde em menos de 1s. " +
        "Retorna valid:true ou a lista de erros encontrados.",
      body: {
        type: "object",
        required: ["html"],
        properties: {
          html: {
            type: "string",
            description: "Conteúdo do index.html da composição HyperFrames",
          },
          compositions: {
            type: "array",
            description:
              "Arquivos de sub-composição adicionais (ex: compositions/scene-1.html), usados junto " +
              "com data-composition-src no index.html para dividir a composição em múltiplos arquivos. " +
              "O runtime hyperframes resolve data-composition-src nativamente — o servidor só materializa " +
              "os arquivos no diretório de sessão antes de rodar o CLI.",
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: {
                  type: "string",
                  description:
                    "Caminho relativo ao diretório de sessão, ex: compositions/scene-1.html",
                },
                content: {
                  type: "string",
                  description:
                    "Conteúdo do arquivo (HTML com <template>, <style> e <script> da cena)",
                },
              },
            },
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            valid: { type: "boolean" },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rule: { type: "string" },
                  message: { type: "string" },
                  element: { type: "string" },
                },
              },
            },
            error_count: { type: "integer" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  },
  async (req, reply) => {
    const { html, compositions = [] } = req.body;

    // Diretório temporário para o lint — não precisa de diretório de job completo
    const lintId = randomUUID();
    const lintDir = join(WORK_DIR, `lint-${lintId}`);

    try {
      await mkdir(lintDir, { recursive: true });
      try {
        await writeCompositionFiles(lintDir, html, compositions);
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }

      const result = await new Promise((resolve) => {
        execFile(
          HF_BIN,
          ["lint", lintDir, "--json"],
          { cwd: lintDir, timeout: 15_000 },
          (err, stdout, stderr) => {
            resolve({ err, stdout, stderr });
          },
        );
      });

      // hyperframes lint sai com código 0 se válido, não-zero se inválido
      // Com --json retorna JSON estruturado no stdout
      if (!result.stdout && result.err) {
        // Lint não suporta --json ou erro inesperado — fallback para texto
        const raw = result.stderr || result.err.message || "";
        const errors = parseTextLintOutput(raw);
        return reply.send({
          valid: errors.length === 0,
          errors,
          error_count: errors.length,
        });
      }

      try {
        const parsed = JSON.parse(result.stdout);
        // Normaliza para o formato da nossa resposta
        const errors = (parsed.errors || parsed.issues || []).map((e) => ({
          rule: e.rule || e.code || "unknown",
          message: e.message || String(e),
          element: e.element || e.selector || "",
        }));
        return reply.send({
          valid: errors.length === 0,
          errors,
          error_count: errors.length,
        });
      } catch {
        // stdout não é JSON — lint provavelmente não suporta --json nessa versão
        const raw = result.stdout + result.stderr;
        const errors = parseTextLintOutput(raw);
        return reply.send({
          valid: errors.length === 0,
          errors,
          error_count: errors.length,
        });
      }
    } finally {
      // Sempre limpa o diretório temporário
      await rm(lintDir, { recursive: true, force: true });
    }
  },
);

/**
 * Fallback: converte saída de texto do lint em array de erros estruturados.
 * Usado quando a versão do hyperframes não suporta --json.
 */
function parseTextLintOutput(raw) {
  if (!raw || !raw.trim()) return [];

  const errors = [];
  const lines = raw.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Ignora linhas de sucesso ou informativas
    if (lower.includes("✓") || lower.includes("ok") || lower.includes("valid"))
      continue;
    if (
      lower.includes("error") ||
      lower.includes("warning") ||
      lower.includes("✗")
    ) {
      errors.push({
        rule: "lint",
        message: line.trim(),
        element: "",
      });
    }
  }

  // Se nenhuma linha pareceu erro mas há conteúdo, trata tudo como erro
  if (errors.length === 0 && raw.trim()) {
    errors.push({ rule: "lint", message: raw.trim(), element: "" });
  }

  return errors;
}

// ─── POST /check ──────────────────────────────────────────────────────────────
// Lint + erros de runtime/console + layout (overflow/clipping/overlap) + assertions
// de *.motion.json + contraste WCAG AA, tudo em uma única sessão de browser real.
// Mais lento que /lint (abre Chromium), mas não gera vídeo. Resposta no mesmo
// formato do /lint (valid/errors/error_count) para não exigir tratamento separado.
app.post(
  "/check",
  {
    schema: {
      summary: "Valida uma composição HyperFrames em um browser real",
      description:
        "Executa hyperframes check no HTML fornecido: lint + erros de console/runtime + " +
        "layout (overflow/clipping/overlap) + assertions de *.motion.json + contraste WCAG AA, " +
        "tudo em uma única sessão de browser. Síncrono — pode levar até ~60s. " +
        "Resposta no mesmo formato do /lint (valid/errors/error_count).",
      body: {
        type: "object",
        required: ["html"],
        properties: {
          html: {
            type: "string",
            description: "Conteúdo do index.html da composição HyperFrames",
          },
          compositions: {
            type: "array",
            description:
              "Arquivos de sub-composição adicionais (ex: compositions/scene-1.html), usados junto " +
              "com data-composition-src no index.html para dividir a composição em múltiplos arquivos. " +
              "O runtime hyperframes resolve data-composition-src nativamente — o servidor só materializa " +
              "os arquivos no diretório de sessão antes de rodar o CLI.",
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: {
                  type: "string",
                  description:
                    "Caminho relativo ao diretório de sessão, ex: compositions/scene-1.html",
                },
                content: {
                  type: "string",
                  description:
                    "Conteúdo do arquivo (HTML com <template>, <style> e <script> da cena)",
                },
              },
            },
          },
          assets: {
            type: "array",
            description:
              "Arquivos adicionais (áudio, imagens) necessários para o check avaliar layout/contraste " +
              'de verdade. Cada item aceita "base64" OU "url".',
            items: {
              type: "object",
              required: ["filename"],
              properties: {
                filename: { type: "string" },
                base64: {
                  type: "string",
                  description: "Conteúdo do arquivo em base64",
                },
                url: {
                  type: "string",
                  description: "URL pública/assinada de onde baixar o asset",
                },
              },
            },
          },
          strict: {
            type: "boolean",
            default: false,
            description: "Se true, também sai não-zero em warnings (--strict)",
          },
          samples: {
            type: "integer",
            description:
              "Nº de amostras no tempo da composição (padrão do CLI: 9)",
          },
          at: {
            type: "array",
            items: { type: "number" },
            description:
              "Timestamps explícitos (segundos) para amostrar, em vez da grade automática",
          },
          tolerance: {
            type: "number",
            description:
              "Overflow em pixels tolerado antes de reportar (padrão do CLI: 2)",
          },
          contrast: {
            type: "boolean",
            default: true,
            description:
              "Se false, pula o passe de contraste WCAG AA (--no-contrast)",
          },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            valid: { type: "boolean" },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rule: { type: "string" },
                  message: { type: "string" },
                  element: { type: "string" },
                },
              },
            },
            error_count: { type: "integer" },
          },
        },
        400: { type: "object", properties: { error: { type: "string" } } },
        500: { type: "object", properties: { error: { type: "string" } } },
      },
    },
  },
  async (req, reply) => {
    const {
      html,
      compositions = [],
      assets = [],
      strict = false,
      samples,
      at,
      tolerance,
      contrast = true,
    } = req.body;

    const checkId = randomUUID();
    const checkDir = join(WORK_DIR, `check-${checkId}`);

    try {
      await mkdir(checkDir, { recursive: true });

      try {
        await writeCompositionFiles(checkDir, html, compositions);
        for (const asset of assets) {
          await saveAsset(checkDir, asset);
        }
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }

      const args = ["check", checkDir, "--json"];
      if (strict) args.push("--strict");
      if (samples != null) args.push("--samples", String(samples));
      if (Array.isArray(at) && at.length) args.push("--at", at.join(","));
      if (tolerance != null) args.push("--tolerance", String(tolerance));
      if (contrast === false) args.push("--no-contrast");

      // Mesmo tratamento de timeout do /render: o check abre browser real, e matar
      // só o PID do CLI deixaria o Chromium vivo como órfão de PID 1. Por isso
      // spawn + detached (execFile descarta `detached`) e coleta manual do stdout.
      //
      // O objeto `err` é montado no mesmo formato que o execFile devolvia
      // (`killed`, `code`, `message`), porque a distinção "erro do servidor vs
      // achado de negócio" logo abaixo depende exatamente desses campos.
      let checkTimedOut = false;
      const result = await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        const cmd = `${HF_BIN} ${args.join(" ")}`;
        const checkProc = spawn(HF_BIN, args, {
          cwd: checkDir,
          ...detachedOpts(),
        });

        const checkTimer = setTimeout(() => {
          checkTimedOut = true;
          killTree(checkProc, "SIGTERM");
          setTimeout(
            () => killTree(checkProc, "SIGKILL"),
            RENDER_KILL_GRACE_MS,
          ).unref();
        }, CHECK_TIMEOUT_MS);

        checkProc.stdout?.on("data", (c) => {
          stdout = appendCapped(stdout, c.toString());
        });
        checkProc.stderr?.on("data", (c) => {
          stderr = appendCapped(stderr, c.toString());
        });

        // Mesmo desfecho-por-`exit` do /render: o check também abre browser, e um
        // Chromium deixado para trás seguraria o `close` até o CHECK_TIMEOUT_MS —
        // 60s de requisição HTTP pendurada por um resultado que já estava pronto.
        settleOnExit(checkProc, {
          drainMs: RENDER_DRAIN_MS,
          killLeftovers: () => killTree(checkProc, "SIGKILL"),
          onSettled: ({ code, signal, error }) => {
            clearTimeout(checkTimer);
            const err =
              error ??
              (code === 0
                ? null
                : {
                    killed: signal != null,
                    signal,
                    code: signal != null ? null : code,
                    message: `Command failed: ${cmd}\n${stderr}`,
                  });
            resolve({ err, stdout, stderr });
          },
        });
      });

      // Timeout ou falha de execução do próprio processo — não é resultado de negócio,
      // é erro do servidor (a composição não chegou a ser avaliada por completo)
      if (
        result.err &&
        (checkTimedOut ||
          result.err.killed ||
          typeof result.err.code !== "number")
      ) {
        const reason =
          checkTimedOut || result.err.killed
            ? `hyperframes check excedeu o tempo limite (${Math.round(CHECK_TIMEOUT_MS / 1000)}s)`
            : result.err.message || String(result.err);
        return reply.code(500).send({ error: reason });
      }

      // Exit code não-zero aqui significa apenas "achou issues" (ok:false), não falha do
      // servidor — igual ao /lint, hyperframes check --json ainda entrega JSON no stdout
      if (!result.stdout) {
        const raw = result.stderr || (result.err && result.err.message) || "";
        const errors = parseTextLintOutput(raw);
        return reply.send({
          valid: errors.length === 0,
          errors,
          error_count: errors.length,
        });
      }

      try {
        const parsed = JSON.parse(result.stdout);
        // hyperframes check agrega achados em 5 categorias (lint/runtime/layout/motion/contrast) —
        // achata tudo num array só e normaliza pro mesmo formato do /lint
        const findings = [
          ...(parsed.lint?.findings || []),
          ...(parsed.runtime?.findings || []),
          ...(parsed.layout?.findings || []),
          ...(parsed.motion?.findings || []),
          ...(parsed.contrast?.findings || []),
        ];
        const errors = findings.map((f) => ({
          rule: f.rule || f.code || "unknown",
          message: f.message || String(f),
          element: f.element || f.selector || "",
        }));
        const valid = typeof parsed.ok === "boolean" ? parsed.ok : !result.err;
        return reply.send({ valid, errors, error_count: errors.length });
      } catch {
        // stdout não é JSON — versão do CLI sem --json ou saída inesperada
        const raw = result.stdout + result.stderr;
        const errors = parseTextLintOutput(raw);
        return reply.send({
          valid: errors.length === 0,
          errors,
          error_count: errors.length,
        });
      }
    } finally {
      // Sempre limpa o diretório temporário, em qualquer caminho de saída
      await rm(checkDir, { recursive: true, force: true });
    }
  },
);

// ─── POST /render ─────────────────────────────────────────────────────────────
app.post(
  "/render",
  {
    schema: {
      summary: "Envia uma composição HTML para renderização",
      description:
        "Inicia um job assíncrono. Retorna job_id para polling.\n\n" +
        "Aceita a composição de duas formas mutuamente exclusivas: `html` (com os " +
        "opcionais `compositions`/`assets`), ou `preview_id` — que renderiza o " +
        "diretório de um preview existente **como ele está no disco**, incluindo as " +
        "edições salvas na Studio. Com `preview_id` os assets já estão no diretório, " +
        "então não precisam ser reenviados.",
      body: {
        type: "object",
        properties: {
          html: {
            type: "string",
            description:
              "Conteúdo do index.html da composição HyperFrames. Mutuamente exclusivo com preview_id.",
          },
          preview_id: {
            type: "string",
            description:
              "UUID devolvido por POST /preview. Renderiza o diretório desse preview como está " +
              "em disco (com as edições salvas na Studio). Mutuamente exclusivo com html.",
          },
          compositions: {
            type: "array",
            description:
              "Arquivos de sub-composição adicionais (ex: compositions/scene-1.html), usados junto " +
              "com data-composition-src no index.html para dividir a composição em múltiplos arquivos. " +
              "O runtime hyperframes resolve data-composition-src nativamente — o servidor só materializa " +
              "os arquivos no diretório de sessão antes de rodar o CLI.",
            items: {
              type: "object",
              required: ["path", "content"],
              properties: {
                path: {
                  type: "string",
                  description:
                    "Caminho relativo ao diretório de sessão, ex: compositions/scene-1.html",
                },
                content: {
                  type: "string",
                  description:
                    "Conteúdo do arquivo (HTML com <template>, <style> e <script> da cena)",
                },
              },
            },
          },
          assets: {
            type: "array",
            description:
              'Arquivos adicionais (áudio, imagens). Cada item aceita "base64" OU "url" ' +
              "(asset já hospedado em bucket/CDN externo — evita o overhead do base64).",
            items: {
              type: "object",
              required: ["filename"],
              properties: {
                filename: {
                  type: "string",
                  description: "Nome do arquivo, ex: narration.mp3",
                },
                base64: {
                  type: "string",
                  description: "Conteúdo do arquivo em base64",
                },
                url: {
                  type: "string",
                  description: "URL pública/assinada de onde baixar o asset",
                },
              },
            },
          },
          fps: {
            type: "integer",
            default: 30,
            description: "Frames por segundo do vídeo de saída",
          },
        },
      },
      response: {
        202: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            status_url: { type: "string" },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const {
      html,
      preview_id: previewIdParam,
      compositions = [],
      assets = [],
      fps = 30,
    } = req.body;

    // Exatamente um dos dois. Aceitar os dois juntos seria ambíguo justamente no
    // caso que importa: renderizar depois de editar na Studio.
    if (!html && !previewIdParam) {
      return reply
        .code(400)
        .send({ error: 'Informe "html" ou "preview_id" (um dos dois)' });
    }
    if (html && previewIdParam) {
      return reply
        .code(400)
        .send({ error: '"html" e "preview_id" são mutuamente exclusivos' });
    }

    // O previewId vem do cliente e é concatenado num path — restringe ao formato
    // exato que randomUUID() gera, o que também barra qualquer traversal.
    if (previewIdParam && !UUID_RE.test(previewIdParam)) {
      return reply
        .code(400)
        .send({ error: `preview_id inválido: "${previewIdParam}"` });
    }

    // A vaga é tomada DEPOIS das validações e ANTES de criar o jobDir: um 429 não
    // pode deixar diretório para trás, e um 400 não pode consumir vaga.
    const slot = renderSlots.acquire();
    if (!slot.ok) {
      return reply
        .code(429)
        .header("Retry-After", String(slot.retryAfterS))
        .send({
          error:
            `Já há ${slot.inFlight} render em andamento (limite: ${renderSlots.max()}). ` +
            `Cada render sobe vários Chromiums — rodar em paralelo faz os dois estourarem o timeout. ` +
            `Tente de novo em ~${slot.retryAfterS}s.`,
          renders_in_flight: slot.inFlight,
          retry_after_s: slot.retryAfterS,
        });
    }

    // A partir daqui, TODO caminho de saída precisa devolver a vaga: um release
    // perdido tranca o endpoint até o próximo restart.
    let slotReleased = false;
    const releaseSlot = () => {
      if (slotReleased) return;
      slotReleased = true;
      renderSlots.release();
    };

    const jobId = randomUUID();
    const jobDir = join(WORK_DIR, jobId);
    const outputDir = join(jobDir, "output");

    if (previewIdParam) {
      const previewDir = join(PREVIEW_DIR, previewIdParam);
      if (!existsSync(previewDir)) {
        releaseSlot();
        return reply.code(404).send({
          error:
            `Preview "${previewIdParam}" não encontrado (expirado ou nunca criado). ` +
            "Crie um novo com POST /preview.",
        });
      }
      try {
        // Copia em vez de renderizar no lugar: o job fica independente do preview,
        // que pode seguir sendo editado ou expirar sem afetar este render.
        await cp(previewDir, jobDir, { recursive: true });
        await mkdir(outputDir, { recursive: true });
      } catch (err) {
        await rm(jobDir, { recursive: true, force: true });
        releaseSlot();
        return reply.code(500).send({
          error: `Falha ao copiar o diretório do preview: ${err.message}`,
        });
      }
    } else {
      try {
        await mkdir(outputDir, { recursive: true });
      } catch (err) {
        releaseSlot();
        return reply
          .code(500)
          .send({ error: `Falha ao criar o diretório do job: ${err.message}` });
      }
      try {
        await writeCompositionFiles(jobDir, html, compositions);
        for (const asset of assets) {
          await saveAsset(jobDir, asset);
        }
      } catch (err) {
        await rm(jobDir, { recursive: true, force: true });
        releaseSlot();
        return reply.code(400).send({ error: err.message });
      }
    }

    const outputFile = join(outputDir, "video.mp4");

    // Acumula stdout/stderr do render para diagnóstico
    let renderLog = "";

    // Timeout próprio, em vez do `timeout` do execFile: aquele sinaliza só o PID do
    // CLI, e os workers Chromium — filhos dele — sobrevivem, viram órfãos de PID 1
    // e seguem consumindo CPU e shm até o container reiniciar. Aqui o sinal vai
    // para o grupo inteiro (ver killTree).
    let timedOut = false;
    let idleKilled = false;

    // Render em background — não bloqueia a resposta
    // CLI: hyperframes render [DIR] -o <output> -f <fps> -w <workers>
    //
    // spawn e não execFile: `detached` é obrigatório para o kill de grupo, e o
    // execFile o descarta em silêncio (ver killTree). O stdout/stderr já era
    // consumido à mão logo abaixo; o que a troca exige é montar o `err` e aplicar
    // o teto de log que o `maxBuffer` dava de graça.
    const renderArgs = [
      "render",
      jobDir,
      "-o",
      outputFile,
      "-f",
      String(fps),
      "-w",
      String(RENDER_WORKERS),
      "--no-browser-gpu",
    ];
    const renderCmd = `${HF_BIN} ${renderArgs.join(" ")}`;
    const proc = spawn(HF_BIN, renderArgs, {
      cwd: jobDir,
      ...detachedOpts(),
    });

    // Um spawn que falha (ENOENT no binário) emite "error" E "close": sem esta
    // guarda o desfecho seria escrito duas vezes, e a segunda passada sobrescreveria
    // o error.txt com uma mensagem pior que a primeira.
    let settled = false;
    const onRenderDone = async (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      idleWatchdog.stop();
      activeRenders.delete(jobId);
      releaseSlot();

      // Sempre persiste o log do render para diagnóstico
      await writeFile(join(jobDir, "render.log"), renderLog, "utf8").catch(
        () => {},
      );

      // Falha explícita do processo (exit != 0, timeout, etc.)
      if (err) {
        // Quem mata é o nosso timer, então o desfecho do processo não sabe dizer
        // que foi timeout — a mensagem é sintetizada aqui. Sem isso o GET /status
        // devolveria só "Command failed" e o diagnóstico regrediria.
        // A ordem importa: quem morreu por ociosidade JÁ falhou antes, e o erro
        // real está no log logo abaixo. Chamar isso de "timeout" mandaria o
        // diagnóstico para o lugar errado — foi o que essa mensagem fez uma vez.
        const message = idleKilled
          ? `O CLI parou de produzir saída por ${Math.round(RENDER_IDLE_MS / 1000)}s ` +
            `e não saiu sozinho (RENDER_IDLE_MS). O motivo real da falha está no log abaixo — ` +
            `esta linha é só o servidor encerrando um processo que já tinha desistido.`
          : timedOut
            ? `Render cancelado por timeout após ${Math.round(RENDER_TIMEOUT_MS / 1000)}s ` +
              `(RENDER_TIMEOUT_MS). O grupo de processos, workers Chromium inclusive, foi encerrado.`
            : err.message;
        app.log.error({ jobId, err: message, timedOut }, "Render failed");
        await writeFile(
          join(jobDir, "error.txt"),
          `${message}\n\n--- log ---\n${renderLog}`,
          "utf8",
        );
        return;
      }

      // Exit 0 NÃO garante vídeo: valida que o arquivo existe e não está vazio
      let size = 0;
      try {
        size = (await stat(outputFile)).size;
      } catch {}
      if (size > 0) {
        app.log.info({ jobId, size }, "Render complete");
        await writeFile(join(jobDir, "done.txt"), "ok", "utf8");
      } else {
        app.log.error(
          { jobId },
          "Render terminou com exit 0 mas o vídeo está vazio/ausente",
        );
        await writeFile(
          join(jobDir, "error.txt"),
          `Render saiu com código 0 mas ${outputFile} ficou vazio ou ausente (${size} bytes).\n\n--- log ---\n${renderLog}`,
          "utf8",
        );
      }
    };

    activeRenders.set(jobId, proc);

    // O timer roda em qualquer modo: com KILL_PROCESS_GROUP=false o killTree cai no
    // proc.kill() de PID único, que é exatamente o que o timeout do execFile fazia.
    const killTimer = setTimeout(() => {
      timedOut = true;
      app.log.warn(
        { jobId, timeoutMs: RENDER_TIMEOUT_MS },
        "Render excedeu o timeout — encerrando o grupo de processos",
      );
      killTree(proc, "SIGTERM");
      // Graça para o CLI fechar os browsers sozinho; depois disso, SIGKILL no
      // grupo. Sem este segundo passo, um CLI travado segura os workers vivos.
      setTimeout(() => killTree(proc, "SIGKILL"), RENDER_KILL_GRACE_MS).unref();
    }, RENDER_TIMEOUT_MS);

    // Freio para o CLI que falha e não sai (ver idle-watchdog.mjs). Diferente do
    // killTimer acima: aquele é o teto absoluto de um render que ainda pode estar
    // trabalhando; este dispara no silêncio, que é o que um CLI desistente produz.
    const idleWatchdog = createIdleWatchdog({
      idleMs: RENDER_IDLE_MS,
      onIdle: () => {
        idleKilled = true;
        app.log.warn(
          { jobId, idleMs: RENDER_IDLE_MS },
          "Render sem saída há tempo demais e sem sair — encerrando o grupo",
        );
        killTree(proc, "SIGTERM");
        setTimeout(
          () => killTree(proc, "SIGKILL"),
          RENDER_KILL_GRACE_MS,
        ).unref();
      },
    });
    idleWatchdog.touch();

    // Captura stdout/stderr do render para o log do job e para o console do container
    const onRenderChunk = (chunk) => {
      const text = chunk.toString();
      renderLog = appendCapped(renderLog, text);
      // Qualquer saída é prova de vida: rearma o watchdog.
      idleWatchdog.touch();
      process.stdout.write(`[render ${jobId.slice(0, 8)}] ${text}`);
    };
    proc.stdout?.on("data", onRenderChunk);
    proc.stderr?.on("data", onRenderChunk);

    // Desfecho pelo `exit`, com uma janela curta para o log drenar — nunca pelo
    // `close` (ver child-outcome.mjs). O `close` espera TODOS os pipes fecharem, e
    // o write-end deles é herdado por cada neto: quando o render falha, o CLI sai
    // deixando um Chromium vivo que segura o stdout, e o `close` não chega nunca.
    // Foi o que prendeu um render real em "processing" por 1800s enquanto o mutex
    // de concorrência devolvia 429 para todo o resto.
    settleOnExit(proc, {
      drainMs: RENDER_DRAIN_MS,
      // A janela venceu: sobrou processo do render segurando os pipes. Reapa aqui,
      // que é o único ponto que ainda sabe qual grupo é. Sai como warn porque o
      // esperado é o CLI fechar os próprios browsers.
      killLeftovers: () => {
        app.log.warn(
          { jobId },
          "CLI saiu mas os pipes ficaram abertos — matando o que sobrou do grupo",
        );
        killTree(proc, "SIGKILL");
      },
      onSettled: ({ code, signal, error }) => {
        // ENOENT no binário e afins: o processo nunca chegou a rodar.
        if (error) return onRenderDone(error);
        if (code === 0) return onRenderDone(null);
        onRenderDone({
          killed: signal != null,
          signal,
          code: signal != null ? null : code,
          message: `Command failed: ${renderCmd}\n${renderLog.slice(-4000)}`,
        });
      },
    });

    reply.code(202).send({
      job_id: jobId,
      status_url: `/status/${jobId}`,
    });
  },
);

// ─── GET /status/:jobId ───────────────────────────────────────────────────────
app.get(
  "/status/:jobId",
  {
    schema: {
      summary: "Verifica o status de um job de renderização",
      params: {
        type: "object",
        properties: { jobId: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            status: { type: "string", enum: ["processing", "done", "error"] },
            download_url: { type: "string" },
            error: { type: "string" },
          },
        },
        404: {
          type: "object",
          properties: { error: { type: "string" } },
        },
      },
    },
  },
  async (req, reply) => {
    const { jobId } = req.params;
    const jobDir = join(WORK_DIR, jobId);

    if (!existsSync(jobDir)) {
      return reply.code(404).send({ error: "Job não encontrado" });
    }

    if (existsSync(join(jobDir, "done.txt"))) {
      return {
        job_id: jobId,
        status: "done",
        download_url: `/download/${jobId}`,
      };
    }

    if (existsSync(join(jobDir, "error.txt"))) {
      const msg = await readFile(join(jobDir, "error.txt"), "utf8");
      return { job_id: jobId, status: "error", error: msg };
    }

    return { job_id: jobId, status: "processing" };
  },
);

// ─── GET /download/:jobId ─────────────────────────────────────────────────────
app.get(
  "/download/:jobId",
  {
    schema: {
      summary: "Baixa o MP4 renderizado",
      params: {
        type: "object",
        properties: { jobId: { type: "string" } },
      },
    },
  },
  async (req, reply) => {
    const { jobId } = req.params;
    const videoPath = join(WORK_DIR, jobId, "output", "video.mp4");

    if (!existsSync(videoPath)) {
      return reply
        .code(404)
        .send({ error: "Vídeo não encontrado ou ainda em processamento" });
    }

    // Não serve arquivo vazio — sinaliza falha de render em vez de baixar 0 bytes
    const { size } = await stat(videoPath);
    if (size === 0) {
      return reply.code(409).send({
        error: "Render produziu um vídeo vazio. Veja GET /logs/" + jobId,
      });
    }

    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", size);
    reply.header(
      "Content-Disposition",
      `attachment; filename="video-${jobId}.mp4"`,
    );

    // Limpa o job 1 min após o início do download
    setTimeout(
      () => rm(join(WORK_DIR, jobId), { recursive: true, force: true }),
      60_000,
    );

    // IMPORTANTE: em handler async, é preciso RETORNAR o stream/reply — senão o
    // Fastify resolve a promise com undefined e corta o corpo (download de 0 bytes).
    return reply.send(createReadStream(videoPath));
  },
);

// ─── GET /logs/:jobId ─────────────────────────────────────────────────────────
// Retorna o stdout/stderr capturado do hyperframes render, em texto puro.
app.get(
  "/logs/:jobId",
  {
    schema: {
      summary: "Retorna o log do render (stdout/stderr) de um job",
      params: { type: "object", properties: { jobId: { type: "string" } } },
    },
  },
  async (req, reply) => {
    const logPath = join(WORK_DIR, req.params.jobId, "render.log");
    if (!existsSync(logPath)) {
      return reply.code(404).send({
        error: "Log não encontrado (job inexistente ou ainda em processamento)",
      });
    }
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return reply.send(await readFile(logPath, "utf8"));
  },
);

// ─── Proxy da Studio ──────────────────────────────────────────────────────────
// Serve a Studio do `hyperframes preview` por ESTA porta, para poder injetar o
// polyfill de secure context no HTML dela (studio-polyfill.js). Sem isso, salvar
// edições só funciona em HTTPS ou localhost — ver o comentário no polyfill.
//
// Registrado como um conjunto EXPLÍCITO de rotas, nunca como catch-all: são
// exatamente as rotas de topo do app Hono da Studio, nenhuma delas existente
// nesta API. Assim a mudança é puramente aditiva — nenhuma rota atual é
// interceptada e um path inexistente continua devolvendo o 404 do Fastify.
//
// O cliente da Studio só usa caminhos relativos de mesma origem e faz hash
// routing (#/projects/:id), então proxiar na raiz funciona sem reescrever nada.
// O live-reload é SSE (/api/events), não WebSocket.
if (STUDIO_PROXY_ENABLED) {
  const POLYFILL = await readFile(
    fileURLToPath(new URL("./studio-polyfill.js", import.meta.url)),
    "utf8",
  );

  await app.register(async (studio) => {
    await studio.register(import("@fastify/reply-from"), {
      base: `http://127.0.0.1:${PREVIEW_PORT}`,
      undici: {
        // O SSE de /api/events mantém o CORPO aberto indefinidamente, então
        // bodyTimeout precisa ser 0. Os HEADERS, porém, chegam de imediato em
        // qualquer resposta sadia — deixar headersTimeout em 0 também fazia uma
        // Studio travada pendurar a requisição para sempre.
        bodyTimeout: 0,
        headersTimeout: 10_000,
        // Porta local que não aceita conexão deve falhar na hora, não em 30s.
        connectTimeout: 2_000,
      },
    });

    // Repassa o corpo cru para o upstream. Encapsulado neste escopo, então o
    // parsing JSON das rotas da API principal não é afetado.
    studio.addContentTypeParser("*", (req, payload, done) =>
      done(null, payload),
    );

    // A porta real pode diferir de PREVIEW_PORT se houve conflito no spawn.
    const upstream = () => `http://127.0.0.1:${activePreview.port}`;

    // Sem preview ativo não há para onde proxiar — responde com algo acionável
    // em vez de estourar um ECONNREFUSED contra uma porta morta.
    const requirePreview = (req, reply, done) => {
      if (!activePreview) {
        reply.code(503).send({
          error: "Nenhum preview ativo. Chame POST /preview primeiro.",
        });
        return;
      }
      done();
    };

    // Passthrough puro — nada é bufferizado nem transformado.
    //
    // O `onResponse` existe só por causa do SSE: o Node não manda os headers da
    // resposta enquanto o primeiro byte de corpo não sai, e o /api/events da
    // Studio fica em silêncio até algum arquivo mudar. Sem um flush explícito o
    // EventSource do navegador fica pendurado esperando os headers e o
    // live-reload nunca conecta. (O Hono do upstream faz esse flush sozinho; ao
    // proxiar, ele passa a ser responsabilidade nossa.)
    const passthrough = (req, reply) =>
      reply.from(req.raw.url, {
        getUpstream: upstream,
        onResponse: (originalReq, replyTo, bodyStream) => {
          const isEventStream = String(
            replyTo.getHeader("content-type") ?? "",
          ).includes("text/event-stream");
          replyTo.send(bodyStream);
          if (isEventStream) {
            setImmediate(() => {
              try {
                replyTo.raw.flushHeaders();
              } catch {}
            });
          }
        },
      });

    // Só o documento HTML da Studio é bufferizado, para injetar o polyfill antes
    // do bundle. Ele é type="module" (deferido), então um <script> clássico no
    // <head> sempre roda primeiro — que é o requisito.
    const serveStudioHtml = (req, reply) =>
      reply.from(req.raw.url, {
        getUpstream: upstream,
        rewriteRequestHeaders: (originalReq, headers) => {
          const out = { ...headers };
          // Precisamos do HTML em texto para injetar: sem corpo (304) ou
          // comprimido, a injeção não teria como acontecer.
          delete out["if-none-match"];
          delete out["if-modified-since"];
          out["accept-encoding"] = "identity";
          return out;
        },
        // reply-from já copiou headers e status para `replyTo`; o terceiro
        // argumento é só o stream do corpo.
        onResponse: async (originalReq, replyTo, bodyStream) => {
          const type = String(replyTo.getHeader("content-type") ?? "");
          if (!type.includes("text/html")) {
            replyTo.send(bodyStream);
            return;
          }
          try {
            const chunks = [];
            for await (const chunk of bodyStream) chunks.push(chunk);
            const html = Buffer.concat(chunks)
              .toString("utf8")
              .replace("<head>", `<head><script>${POLYFILL}</script>`);
            replyTo
              .header("content-length", Buffer.byteLength(html))
              .removeHeader("content-encoding")
              .send(html);
          } catch (err) {
            req.log.error(
              { err },
              "Falha ao injetar o polyfill no HTML da Studio",
            );
            replyTo.code(502).send({
              error: `Falha ao servir a Studio: ${err.message}`,
            });
          }
        },
      });

    const proxied = [
      ["GET", "/", serveStudioHtml],
      ["GET", "/studio", serveStudioHtml],
      ["GET", "/__hyperframes_config", passthrough],
      ["GET", "/assets/*", passthrough],
      ["GET", "/icons/*", passthrough],
      ["GET", "/favicon.svg", passthrough],
    ];
    for (const [method, url, handler] of proxied) {
      studio.route({
        method,
        url,
        preHandler: requirePreview,
        handler,
        schema: { hide: true },
      });
    }

    // Toda a API da Studio (arquivos, mutações, preview, render, SSE).
    studio.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      url: "/api/*",
      preHandler: requirePreview,
      handler: passthrough,
      schema: { hide: true },
    });
  });
}

// ─── MCP de autoria ───────────────────────────────────────────────────────────
// Expõe o contrato de composição e o catálogo de templates do HyperFrames como
// tools MCP, para um agente de IA consultar antes de gerar HTML de cena.
// Aditivo: /mcp não existe em nenhuma rota anterior, e o plugin é encapsulado.
if (MCP_ENABLED) {
  await app.register(import("./mcp/index.mjs"), { prefix: "/mcp" });
}

// ─── Encerramento ─────────────────────────────────────────────────────────────
// Obrigatório por causa do `detached: true`: um filho em grupo próprio NÃO morre
// junto com o pai. Sem este handler, trocaríamos o vazamento do timeout por um
// vazamento no restart — os Chromiums do render em andamento sobreviveriam ao
// servidor. (No container o namespace inteiro cai junto, mas em `npm run dev` e
// num deploy que só reinicia o processo, não.)
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(
      { signal, activeRenders: activeRenders.size },
      "Encerrando — matando processos filhos",
    );
    for (const [jobId, proc] of activeRenders) {
      killTree(proc, "SIGTERM");
      app.log.info({ jobId }, "Render interrompido pelo shutdown");
    }
    killTree(activePreview?.proc, "SIGTERM");
    // Graça curta para os filhos fecharem antes de sair.
    setTimeout(() => process.exit(0), 2_000).unref();
    app.close().then(() => process.exit(0));
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Docs disponíveis em http://localhost:${PORT}/docs`);

  if (STUDIO_PROXY_ENABLED) {
    app.log.info(
      { publicBaseUrl: PUBLIC_BASE_URL || null },
      PUBLIC_BASE_URL
        ? `Studio proxiada nesta porta (polyfill de secure context ativo) — preview_url usará ${PUBLIC_BASE_URL}/`
        : `Studio proxiada em http://localhost:${PORT}/ — defina PUBLIC_BASE_URL para que preview_url aponte para cá`,
    );
  } else {
    app.log.info("Proxy da Studio desligado (STUDIO_PROXY=false)");
  }

  app.log.info(
    MCP_ENABLED
      ? `MCP de autoria em http://localhost:${PORT}/mcp (transporte httpStreamable)`
      : "MCP de autoria desligado (MCP_ENABLED=false)",
  );

  // Retenção dos diretórios de preview: uma passada no boot e depois de hora em hora.
  sweepOldPreviews();
  setInterval(sweepOldPreviews, 60 * 60 * 1000).unref();

  // Retenção dos diretórios de job, no mesmo ritmo.
  if (JOB_SWEEP_ENABLED) {
    sweepOldJobs();
    setInterval(sweepOldJobs, 60 * 60 * 1000).unref();
    app.log.info(
      {
        errorRetentionMs: JOB_ERROR_RETENTION_MS,
        doneRetentionMs: JOB_DONE_RETENTION_MS,
      },
      "Varredura de jobs ativa",
    );
  } else {
    app.log.warn(
      "Varredura de jobs desligada (JOB_SWEEP=false) — /tmp cresce sem limite",
    );
  }

  // Rede de segurança contra Chromium órfão. NÃO roda no boot: o container recém-
  // subido não tem órfão nenhum, e a regra de duas passadas precisa de intervalo.
  if (CHROMIUM_JANITOR_ENABLED) {
    setInterval(sweepOrphanChromiums, CHROMIUM_JANITOR_INTERVAL_MS).unref();
  }

  app.log.info(
    {
      maxConcurrentRenders: MAX_CONCURRENT_RENDERS,
      renderTimeoutMs: RENDER_TIMEOUT_MS,
      killProcessGroup: KILL_PROCESS_GROUP,
      chromiumJanitor: CHROMIUM_JANITOR_ENABLED,
    },
    "Guardas de estabilidade do render",
  );
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
