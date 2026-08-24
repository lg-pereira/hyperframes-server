import Fastify from "fastify";
import { execFile } from "node:child_process";
import {
  writeFile,
  mkdir,
  rm,
  readFile,
  stat,
  cp,
  readdir,
} from "node:fs/promises";
import { join, dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
// fixar conforme os cores disponíveis. Ajuste via env RENDER_WORKERS no Coolify.
const RENDER_WORKERS = process.env.RENDER_WORKERS ?? "auto";

// TTL dos previews em ms (padrão: 2 horas)
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

// Porta dedicada ao studio hyperframes preview.
// Deve ser exposta no docker-compose e acessível de fora do container.
// PUBLIC_PREVIEW_URL é a URL base pública para o browser acessar essa porta.
// Ex: PUBLIC_PREVIEW_URL=http://meu-vps.com:3031
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT ?? "3031");
const PUBLIC_PREVIEW_URL = (
  process.env.PUBLIC_PREVIEW_URL ?? `http://localhost:${PREVIEW_PORT}`
).replace(/\/$/, "");

// URL pública desta porta (PORT/3030), por onde a Studio é servida via proxy.
// É o que resolve o bug de save: proxiando a Studio por aqui o servidor consegue
// injetar o polyfill de secure context no HTML dela (ver studio-polyfill.js).
// Enquanto NÃO estiver definida, `preview_url` continua apontando para a 3031
// exatamente como antes — a migração é opt-in. Ex: PUBLIC_BASE_URL=http://meu-vps.com:3030
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

// Desliga o proxy da Studio sem precisar de deploy de código (rollback por env var).
const STUDIO_PROXY_ENABLED = process.env.STUDIO_PROXY !== "false";

// Servidor MCP de autoria em /mcp — dá ao agente de IA (n8n) acesso ao contrato de
// composição e ao catálogo de templates do HyperFrames. Desligável por env var.
const MCP_ENABLED = process.env.MCP_ENABLED !== "false";

// Por quanto tempo os arquivos de um preview sobrevivem depois que o processo morre.
// Precisam sobreviver para que `POST /render {preview_id}` renderize as edições que
// foram salvas na Studio. Padrão: 24 horas.
const PREVIEW_RETENTION_MS = parseInt(
  process.env.PREVIEW_RETENTION_MS ?? String(24 * 60 * 60 * 1000),
);

// Apenas um preview ativo por vez
let activePreview = null; // { proc, previewId, port, timer }

// URL pública da Studio servida por ESTA porta (com o polyfill injetado), ou null
// quando o proxy está desligado ou PUBLIC_BASE_URL não foi definida — caso em que
// o comportamento antigo (entregar a porta do studio direto) é preservado.
function studioProxyUrl() {
  if (!STUDIO_PROXY_ENABLED || !PUBLIC_BASE_URL) return null;
  return `${PUBLIC_BASE_URL}/`;
}

// Mata o processo ativo e limpa todos os studios registrados pelo hyperframes.
// NÃO apaga os arquivos: o que a Studio salvou em disco precisa sobreviver para
// que `POST /render {preview_id}` consiga renderizar as edições. A limpeza fica
// a cargo de sweepOldPreviews() (PREVIEW_RETENTION_MS) ou de um DELETE explícito
// com ?purge=true.
async function killActivePreview({ purge = false } = {}) {
  if (activePreview) {
    clearTimeout(activePreview.timer);
    try {
      activePreview.proc.kill("SIGTERM");
    } catch {}
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
    const proc = execFile(
      HF_BIN,
      ["preview", "--port", String(port), "--no-open", "--force-new"],
      { cwd: dir, timeout: 0 },
    );

    const readyTimeout = setTimeout(() => {
      proc.kill();
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

// Formato exato de randomUUID(). Usado para validar ids vindos do cliente antes
// de compô-los num path.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
          },
        },
      },
    },
  },
  async () => ({ status: "ok", uptime: process.uptime() }),
);

// ─── POST /preview ────────────────────────────────────────────────────────────
app.post(
  "/preview",
  {
    schema: {
      summary: "Cria um preview ao vivo da composição",
      description:
        "Salva o HTML e assets no disco, spawna `hyperframes preview` e retorna " +
        "a URL proxiada pelo servidor. O processo expira em 2 horas.",
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
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { html, compositions = [], assets = [] } = req.body;

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

    // Encerra qualquer preview anterior e limpa o registry do hyperframes
    await killActivePreview();

    const previewId = randomUUID();
    const previewDir = join(PREVIEW_DIR, previewId);
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

    let proc, actualPort;
    try {
      ({ proc, actualPort } = await spawnPreview(previewDir, PREVIEW_PORT));
    } catch (err) {
      await rm(previewDir, { recursive: true, force: true });
      return reply.code(500).send({ error: err.message });
    }

    // Reconstrói a URL pública direta (porta do studio) usando a porta real,
    // que pode diferir de PREVIEW_PORT se houve conflito.
    const basePublic = PUBLIC_PREVIEW_URL.replace(/:\d+$/, "");
    const directUrl =
      actualPort === PREVIEW_PORT
        ? PUBLIC_PREVIEW_URL
        : `${basePublic}:${actualPort}`;

    // Com PUBLIC_BASE_URL definida, a URL entregue é a proxiada por esta porta —
    // é a única em que o polyfill de secure context é injetado, ou seja, a única
    // em que salvar edições funciona fora de HTTPS/localhost. Sem ela, o valor
    // continua sendo exatamente o de antes (porta do studio, sem polyfill).
    const previewUrl = studioProxyUrl() ?? directUrl;

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

    app.log.info({ previewId, port: actualPort }, "Preview started");

    reply.code(201).send({
      preview_id: previewId,
      preview_url: previewUrl,
      preview_url_direct: directUrl,
      expires_in: "2 horas",
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
          age_hours: Math.round(((Date.now() - info.mtimeMs) / 3_600_000) * 10) / 10,
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

      const result = await new Promise((resolve) => {
        execFile(
          HF_BIN,
          args,
          { cwd: checkDir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ err, stdout, stderr }),
        );
      });

      // Timeout ou falha de execução do próprio processo — não é resultado de negócio,
      // é erro do servidor (a composição não chegou a ser avaliada por completo)
      if (
        result.err &&
        (result.err.killed || typeof result.err.code !== "number")
      ) {
        const reason = result.err.killed
          ? "hyperframes check excedeu o tempo limite (60s)"
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

    const jobId = randomUUID();
    const jobDir = join(WORK_DIR, jobId);
    const outputDir = join(jobDir, "output");

    if (previewIdParam) {
      const previewDir = join(PREVIEW_DIR, previewIdParam);
      if (!existsSync(previewDir)) {
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
        return reply.code(500).send({
          error: `Falha ao copiar o diretório do preview: ${err.message}`,
        });
      }
    } else {
      await mkdir(outputDir, { recursive: true });
      try {
        await writeCompositionFiles(jobDir, html, compositions);
        for (const asset of assets) {
          await saveAsset(jobDir, asset);
        }
      } catch (err) {
        await rm(jobDir, { recursive: true, force: true });
        return reply.code(400).send({ error: err.message });
      }
    }

    const outputFile = join(outputDir, "video.mp4");

    // Acumula stdout/stderr do render para diagnóstico
    let renderLog = "";

    // Render em background — não bloqueia a resposta
    // CLI: hyperframes render [DIR] -o <output> -f <fps> -w <workers>
    const proc = execFile(
      HF_BIN,
      [
        "render",
        jobDir,
        "-o",
        outputFile,
        "-f",
        String(fps),
        "-w",
        String(RENDER_WORKERS),
        "--no-browser-gpu",
      ],
      { cwd: jobDir, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }, // timeout 10 min
      async (err) => {
        // Sempre persiste o log do render para diagnóstico
        await writeFile(join(jobDir, "render.log"), renderLog, "utf8").catch(
          () => {},
        );

        // Falha explícita do processo (exit != 0, timeout, etc.)
        if (err) {
          app.log.error({ jobId, err: err.message }, "Render failed");
          await writeFile(
            join(jobDir, "error.txt"),
            `${err.message}\n\n--- log ---\n${renderLog}`,
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
      },
    );

    // Captura stdout/stderr do render para o log do job e para o console do container
    const onRenderChunk = (chunk) => {
      const text = chunk.toString();
      renderLog += text;
      process.stdout.write(`[render ${jobId.slice(0, 8)}] ${text}`);
    };
    proc.stdout?.on("data", onRenderChunk);
    proc.stderr?.on("data", onRenderChunk);

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
      return reply
        .code(409)
        .send({
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
      return reply
        .code(404)
        .send({
          error:
            "Log não encontrado (job inexistente ou ainda em processamento)",
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
    studio.addContentTypeParser("*", (req, payload, done) => done(null, payload));

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
            req.log.error({ err }, "Falha ao injetar o polyfill no HTML da Studio");
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
// tools MCP, para o agente do n8n consultar antes de gerar HTML de cena.
// Aditivo: /mcp não existe em nenhuma rota anterior, e o plugin é encapsulado.
if (MCP_ENABLED) {
  await app.register(import("./mcp/index.mjs"), { prefix: "/mcp" });
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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
