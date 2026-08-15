import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { writeFile, mkdir, rm, readFile, stat } from 'node:fs/promises';
import { join, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Binário local do hyperframes — evita que o npx baixe o pacote a cada chamada
const HF_BIN = fileURLToPath(new URL('./node_modules/.bin/hyperframes', import.meta.url));
const PORT = 3030;
const HOST = '0.0.0.0';
const WORK_DIR = '/tmp/hf-jobs';
const PREVIEW_DIR = '/tmp/hf-previews';

// Nº de workers do render. O `auto` do hyperframes calibra a frio e tende a escolher
// 1 worker mesmo quando a captura em regime é rápida. Em ARM (modo screenshot) compensa
// fixar conforme os cores disponíveis. Ajuste via env RENDER_WORKERS no Coolify.
const RENDER_WORKERS = process.env.RENDER_WORKERS ?? 'auto';

// TTL dos previews em ms (padrão: 2 horas)
const PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;

// Porta dedicada ao studio hyperframes preview.
// Deve ser exposta no docker-compose e acessível de fora do container.
// PUBLIC_PREVIEW_URL é a URL base pública para o browser acessar essa porta.
// Ex: PUBLIC_PREVIEW_URL=http://meu-vps.com:3031
const PREVIEW_PORT = parseInt(process.env.PREVIEW_PORT ?? '3031');
const PUBLIC_PREVIEW_URL = (process.env.PUBLIC_PREVIEW_URL ?? `http://localhost:${PREVIEW_PORT}`).replace(/\/$/, '');

// Apenas um preview ativo por vez
let activePreview = null; // { proc, previewId, timer }

// Mata o processo ativo e limpa todos os studios registrados pelo hyperframes
async function killActivePreview() {
  if (activePreview) {
    clearTimeout(activePreview.timer);
    try { activePreview.proc.kill('SIGTERM'); } catch {}
    rm(join(PREVIEW_DIR, activePreview.previewId), { recursive: true, force: true }).catch(() => {});
    activePreview = null;
  }
  // Garante que o registry interno do hyperframes seja limpo antes do próximo preview
  await new Promise((resolve) => {
    execFile(HF_BIN, ['preview', '--kill-all'], { timeout: 10_000 }, () => resolve());
  });
}

// Spawna hyperframes preview no diretório da composição.
// Parseia a porta real do stdout (pode diferir da solicitada se houver conflito).
function spawnPreview(dir, port) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      HF_BIN,
      ['preview', '--port', String(port), '--no-open', '--force-new'],
      { cwd: dir, timeout: 0 }
    );

    const readyTimeout = setTimeout(
      () => { proc.kill(); reject(new Error('hyperframes preview não iniciou em 30s')); },
      30_000
    );

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
      if (fallback && text.includes('Studio')) {
        resolved = true;
        clearTimeout(readyTimeout);
        resolve({ proc, actualPort: parseInt(fallback[1]) });
      }
    };

    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('error', (err) => { clearTimeout(readyTimeout); reject(err); });
    proc.on('exit', (code) => {
      if (!resolved && code != null && code !== 0) {
        clearTimeout(readyTimeout);
        reject(new Error(`hyperframes preview saiu com código ${code}`));
      }
    });
  });
}

await mkdir(WORK_DIR, { recursive: true });
await mkdir(PREVIEW_DIR, { recursive: true });

// Rejeita paths absolutos ou que escapem do diretório de sessão via "..",
// para impedir escrita fora do previewDir/jobDir (path traversal).
function assertSafeRelativePath(path) {
  if (!path || isAbsolute(path) || path.split(/[/\\]/).includes('..')) {
    throw new Error(`Path inválido: "${path}" (não pode ser absoluto nem conter "..")`);
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
      throw new Error(`Falha ao baixar asset "${asset.filename}" de ${asset.url}: HTTP ${res.status}`);
    }
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  } else if (asset.base64) {
    await writeFile(dest, Buffer.from(asset.base64, 'base64'));
  } else {
    throw new Error(`Asset "${asset.filename}" precisa de "base64" ou "url"`);
  }
}

// Grava o index.html da composição e, opcionalmente, arquivos de sub-composição
// (compositions/scene-N.html, resolvidos pelo runtime hyperframes via data-composition-src).
async function writeCompositionFiles(dir, html, compositions = []) {
  await writeFile(join(dir, 'index.html'), html, 'utf8');
  for (const composition of compositions) {
    assertSafeRelativePath(composition.path);
    const dest = join(dir, composition.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, composition.content, 'utf8');
  }
}

const app = Fastify({
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  },
});

// ─── Swagger docs em /docs ───────────────────────────────────────────────────
await app.register(import('@fastify/swagger'), {
  openapi: {
    info: {
      title: 'HyperFrames Server',
      description: 'API para renderização de vídeos com HyperFrames (Chromium + FFmpeg)',
      version: '1.0.0',
    },
  },
});

await app.register(import('@fastify/swagger-ui'), {
  routePrefix: '/docs',
  uiConfig: { docExpansion: 'full' },
    theme: {
    css: [{ filename: 'theme.css', content: '.topbar { display: none }' }],
  },
});


// ─── Health check ─────────────────────────────────────────────────────────────
app.get(
  '/health',
  {
    schema: {
      summary: 'Health check',
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            uptime: { type: 'number' },
          },
        },
      },
    },
  },
  async () => ({ status: 'ok', uptime: process.uptime() })
);

// ─── POST /preview ────────────────────────────────────────────────────────────
app.post(
  '/preview',
  {
    schema: {
      summary: 'Cria um preview ao vivo da composição',
      description:
        'Salva o HTML e assets no disco, spawna `hyperframes preview` e retorna ' +
        'a URL proxiada pelo servidor. O processo expira em 2 horas.',
      body: {
        type: 'object',
        required: ['html'],
        properties: {
          html: {
            type: 'string',
            description: 'Conteúdo do index.html da composição HyperFrames',
          },
          compositions: {
            type: 'array',
            description:
              'Arquivos de sub-composição adicionais (ex: compositions/scene-1.html), usados junto ' +
              'com data-composition-src no index.html para dividir a composição em múltiplos arquivos. ' +
              'O runtime hyperframes resolve data-composition-src nativamente — o servidor só materializa ' +
              'os arquivos no diretório de sessão antes de rodar o CLI.',
            items: {
              type: 'object',
              required: ['path', 'content'],
              properties: {
                path: {
                  type: 'string',
                  description: 'Caminho relativo ao diretório de sessão, ex: compositions/scene-1.html',
                },
                content: {
                  type: 'string',
                  description: 'Conteúdo do arquivo (HTML com <template>, <style> e <script> da cena)',
                },
              },
            },
          },
          assets: {
            type: 'array',
            description:
              'Arquivos adicionais (áudio, imagens). Cada item aceita "base64" OU "url" ' +
              '(asset já hospedado em bucket/CDN externo — evita o overhead do base64).',
            items: {
              type: 'object',
              required: ['filename'],
              properties: {
                filename: { type: 'string' },
                base64: { type: 'string', description: 'Conteúdo do arquivo em base64' },
                url: { type: 'string', description: 'URL pública/assinada de onde baixar o asset' },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            preview_id: { type: 'string' },
            preview_url: { type: 'string' },
            expires_in: { type: 'string' },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { html, compositions = [], assets = [] } = req.body;

    // A Studio usa globalThis.crypto.randomUUID/crypto.subtle ao salvar edições, e o
    // navegador só expõe essas APIs em secure context (HTTPS ou localhost). Se
    // PUBLIC_PREVIEW_URL apontar pra HTTP fora de localhost, o save vai falhar na Studio
    // mesmo com o preview funcionando — avisa no log sem bloquear a criação do preview.
    if (PUBLIC_PREVIEW_URL.startsWith('http://')) {
      const previewHost = new URL(PUBLIC_PREVIEW_URL).hostname;
      if (previewHost !== 'localhost' && previewHost !== '127.0.0.1') {
        app.log.warn(
          { publicPreviewUrl: PUBLIC_PREVIEW_URL },
          'PUBLIC_PREVIEW_URL não é HTTPS nem localhost — a Studio vai falhar ao salvar edições ' +
          '(crypto.randomUUID/crypto.subtle indisponíveis fora de secure context). Configure HTTPS no Coolify.'
        );
      }
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

    // Reconstrói a URL pública usando a porta real (pode diferir de PREVIEW_PORT)
    const basePublic = PUBLIC_PREVIEW_URL.replace(/:\d+$/, '');
    const previewUrl = actualPort === PREVIEW_PORT
      ? PUBLIC_PREVIEW_URL
      : `${basePublic}:${actualPort}`;

    const timer = setTimeout(() => killActivePreview(), PREVIEW_TTL_MS);
    activePreview = { proc, previewId, timer };

    app.log.info({ previewId, port: actualPort }, 'Preview started');

    reply.code(201).send({
      preview_id: previewId,
      preview_url: previewUrl,
      expires_in: '2 horas',
    });
  }
);

// ─── DELETE /preview/:previewId ───────────────────────────────────────────────
app.delete(
  '/preview/:previewId',
  {
    schema: {
      summary: 'Encerra o preview ativo',
      params: {
        type: 'object',
        properties: { previewId: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { deleted: { type: 'boolean' } } },
      },
    },
  },
  async (req, reply) => {
    if (!activePreview || activePreview.previewId !== req.params.previewId) {
      return reply.code(404).send({ error: 'Preview não encontrado' });
    }
    await killActivePreview();
    app.log.info({ previewId: req.params.previewId }, 'Preview deleted');
    return { deleted: true };
  }
);

// ─── POST /lint ───────────────────────────────────────────────────────────────
// Valida o HTML da composição sem renderizar. Síncrono e instantâneo.
// Use antes do /preview ou /render para capturar erros do agente de IA.
app.post(
  '/lint',
  {
    schema: {
      summary: 'Valida uma composição HyperFrames sem renderizar',
      description:
        'Executa hyperframes lint no HTML fornecido. Síncrono — responde em menos de 1s. ' +
        'Retorna valid:true ou a lista de erros encontrados.',
      body: {
        type: 'object',
        required: ['html'],
        properties: {
          html: {
            type: 'string',
            description: 'Conteúdo do index.html da composição HyperFrames',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rule: { type: 'string' },
                  message: { type: 'string' },
                  element: { type: 'string' },
                },
              },
            },
            error_count: { type: 'integer' },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { html } = req.body;

    // Arquivo temporário para o lint — não precisa de diretório de job completo
    const lintId = randomUUID();
    const lintDir = join(WORK_DIR, `lint-${lintId}`);
    const lintFile = join(lintDir, 'index.html');

    try {
      await mkdir(lintDir, { recursive: true });
      await writeFile(lintFile, html, 'utf8');

      const result = await new Promise((resolve) => {
        execFile(
          HF_BIN,
          ['lint', lintDir, '--json'],
          { cwd: lintDir, timeout: 15_000 },
          (err, stdout, stderr) => {
            resolve({ err, stdout, stderr });
          }
        );
      });

      // hyperframes lint sai com código 0 se válido, não-zero se inválido
      // Com --json retorna JSON estruturado no stdout
      if (!result.stdout && result.err) {
        // Lint não suporta --json ou erro inesperado — fallback para texto
        const raw = result.stderr || result.err.message || '';
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
          rule: e.rule || e.code || 'unknown',
          message: e.message || String(e),
          element: e.element || e.selector || '',
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
      // Sempre limpa o arquivo temporário
      await rm(lintDir, { recursive: true, force: true });
    }
  }
);

/**
 * Fallback: converte saída de texto do lint em array de erros estruturados.
 * Usado quando a versão do hyperframes não suporta --json.
 */
function parseTextLintOutput(raw) {
  if (!raw || !raw.trim()) return [];

  const errors = [];
  const lines = raw.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Ignora linhas de sucesso ou informativas
    if (lower.includes('✓') || lower.includes('ok') || lower.includes('valid')) continue;
    if (lower.includes('error') || lower.includes('warning') || lower.includes('✗')) {
      errors.push({
        rule: 'lint',
        message: line.trim(),
        element: '',
      });
    }
  }

  // Se nenhuma linha pareceu erro mas há conteúdo, trata tudo como erro
  if (errors.length === 0 && raw.trim()) {
    errors.push({ rule: 'lint', message: raw.trim(), element: '' });
  }

  return errors;
}

// ─── POST /check ──────────────────────────────────────────────────────────────
// Lint + erros de runtime/console + layout (overflow/clipping/overlap) + assertions
// de *.motion.json + contraste WCAG AA, tudo em uma única sessão de browser real.
// Mais lento que /lint (abre Chromium), mas não gera vídeo. Resposta no mesmo
// formato do /lint (valid/errors/error_count) para não exigir tratamento separado.
app.post(
  '/check',
  {
    schema: {
      summary: 'Valida uma composição HyperFrames em um browser real',
      description:
        'Executa hyperframes check no HTML fornecido: lint + erros de console/runtime + ' +
        'layout (overflow/clipping/overlap) + assertions de *.motion.json + contraste WCAG AA, ' +
        'tudo em uma única sessão de browser. Síncrono — pode levar até ~60s. ' +
        'Resposta no mesmo formato do /lint (valid/errors/error_count).',
      body: {
        type: 'object',
        required: ['html'],
        properties: {
          html: {
            type: 'string',
            description: 'Conteúdo do index.html da composição HyperFrames',
          },
          assets: {
            type: 'array',
            description:
              'Arquivos adicionais (áudio, imagens) necessários para o check avaliar layout/contraste ' +
              'de verdade. Cada item aceita "base64" OU "url".',
            items: {
              type: 'object',
              required: ['filename'],
              properties: {
                filename: { type: 'string' },
                base64: { type: 'string', description: 'Conteúdo do arquivo em base64' },
                url: { type: 'string', description: 'URL pública/assinada de onde baixar o asset' },
              },
            },
          },
          strict: {
            type: 'boolean',
            default: false,
            description: 'Se true, também sai não-zero em warnings (--strict)',
          },
          samples: {
            type: 'integer',
            description: 'Nº de amostras no tempo da composição (padrão do CLI: 9)',
          },
          at: {
            type: 'array',
            items: { type: 'number' },
            description: 'Timestamps explícitos (segundos) para amostrar, em vez da grade automática',
          },
          tolerance: {
            type: 'number',
            description: 'Overflow em pixels tolerado antes de reportar (padrão do CLI: 2)',
          },
          contrast: {
            type: 'boolean',
            default: true,
            description: 'Se false, pula o passe de contraste WCAG AA (--no-contrast)',
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            valid: { type: 'boolean' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rule: { type: 'string' },
                  message: { type: 'string' },
                  element: { type: 'string' },
                },
              },
            },
            error_count: { type: 'integer' },
          },
        },
        400: { type: 'object', properties: { error: { type: 'string' } } },
        500: { type: 'object', properties: { error: { type: 'string' } } },
      },
    },
  },
  async (req, reply) => {
    const { html, assets = [], strict = false, samples, at, tolerance, contrast = true } = req.body;

    const checkId = randomUUID();
    const checkDir = join(WORK_DIR, `check-${checkId}`);

    try {
      await mkdir(checkDir, { recursive: true });
      await writeFile(join(checkDir, 'index.html'), html, 'utf8');

      try {
        for (const asset of assets) {
          await saveAsset(checkDir, asset);
        }
      } catch (err) {
        return reply.code(400).send({ error: err.message });
      }

      const args = ['check', checkDir, '--json'];
      if (strict) args.push('--strict');
      if (samples != null) args.push('--samples', String(samples));
      if (Array.isArray(at) && at.length) args.push('--at', at.join(','));
      if (tolerance != null) args.push('--tolerance', String(tolerance));
      if (contrast === false) args.push('--no-contrast');

      const result = await new Promise((resolve) => {
        execFile(
          HF_BIN,
          args,
          { cwd: checkDir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 },
          (err, stdout, stderr) => resolve({ err, stdout, stderr })
        );
      });

      // Timeout ou falha de execução do próprio processo — não é resultado de negócio,
      // é erro do servidor (a composição não chegou a ser avaliada por completo)
      if (result.err && (result.err.killed || typeof result.err.code !== 'number')) {
        const reason = result.err.killed
          ? 'hyperframes check excedeu o tempo limite (60s)'
          : (result.err.message || String(result.err));
        return reply.code(500).send({ error: reason });
      }

      // Exit code não-zero aqui significa apenas "achou issues" (ok:false), não falha do
      // servidor — igual ao /lint, hyperframes check --json ainda entrega JSON no stdout
      if (!result.stdout) {
        const raw = result.stderr || (result.err && result.err.message) || '';
        const errors = parseTextLintOutput(raw);
        return reply.send({ valid: errors.length === 0, errors, error_count: errors.length });
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
          rule: f.rule || f.code || 'unknown',
          message: f.message || String(f),
          element: f.element || f.selector || '',
        }));
        const valid = typeof parsed.ok === 'boolean' ? parsed.ok : !result.err;
        return reply.send({ valid, errors, error_count: errors.length });
      } catch {
        // stdout não é JSON — versão do CLI sem --json ou saída inesperada
        const raw = result.stdout + result.stderr;
        const errors = parseTextLintOutput(raw);
        return reply.send({ valid: errors.length === 0, errors, error_count: errors.length });
      }
    } finally {
      // Sempre limpa o diretório temporário, em qualquer caminho de saída
      await rm(checkDir, { recursive: true, force: true });
    }
  }
);

// ─── POST /render ─────────────────────────────────────────────────────────────
app.post(
  '/render',
  {
    schema: {
      summary: 'Envia uma composição HTML para renderização',
      description: 'Inicia um job assíncrono. Retorna job_id para polling.',
      body: {
        type: 'object',
        required: ['html'],
        properties: {
          html: {
            type: 'string',
            description: 'Conteúdo do index.html da composição HyperFrames',
          },
          compositions: {
            type: 'array',
            description:
              'Arquivos de sub-composição adicionais (ex: compositions/scene-1.html), usados junto ' +
              'com data-composition-src no index.html para dividir a composição em múltiplos arquivos. ' +
              'O runtime hyperframes resolve data-composition-src nativamente — o servidor só materializa ' +
              'os arquivos no diretório de sessão antes de rodar o CLI.',
            items: {
              type: 'object',
              required: ['path', 'content'],
              properties: {
                path: {
                  type: 'string',
                  description: 'Caminho relativo ao diretório de sessão, ex: compositions/scene-1.html',
                },
                content: {
                  type: 'string',
                  description: 'Conteúdo do arquivo (HTML com <template>, <style> e <script> da cena)',
                },
              },
            },
          },
          assets: {
            type: 'array',
            description:
              'Arquivos adicionais (áudio, imagens). Cada item aceita "base64" OU "url" ' +
              '(asset já hospedado em bucket/CDN externo — evita o overhead do base64).',
            items: {
              type: 'object',
              required: ['filename'],
              properties: {
                filename: { type: 'string', description: 'Nome do arquivo, ex: narration.mp3' },
                base64: { type: 'string', description: 'Conteúdo do arquivo em base64' },
                url: { type: 'string', description: 'URL pública/assinada de onde baixar o asset' },
              },
            },
          },
          fps: {
            type: 'integer',
            default: 30,
            description: 'Frames por segundo do vídeo de saída',
          },
        },
      },
      response: {
        202: {
          type: 'object',
          properties: {
            job_id: { type: 'string' },
            status_url: { type: 'string' },
          },
        },
      },
    },
  },
  async (req, reply) => {
    const { html, compositions = [], assets = [], fps = 30 } = req.body;

    const jobId = randomUUID();
    const jobDir = join(WORK_DIR, jobId);
    const outputDir = join(jobDir, 'output');

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

    const outputFile = join(outputDir, 'video.mp4');

    // Acumula stdout/stderr do render para diagnóstico
    let renderLog = '';

    // Render em background — não bloqueia a resposta
    // CLI: hyperframes render [DIR] -o <output> -f <fps> -w <workers>
    const proc = execFile(
      HF_BIN,
      ['render', jobDir,
        '-o', outputFile,
        '-f', String(fps),
        '-w', String(RENDER_WORKERS),
        '--no-browser-gpu',
      ],
      { cwd: jobDir, timeout: 10 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 }, // timeout 10 min
      async (err) => {
        // Sempre persiste o log do render para diagnóstico
        await writeFile(join(jobDir, 'render.log'), renderLog, 'utf8').catch(() => {});

        // Falha explícita do processo (exit != 0, timeout, etc.)
        if (err) {
          app.log.error({ jobId, err: err.message }, 'Render failed');
          await writeFile(join(jobDir, 'error.txt'), `${err.message}\n\n--- log ---\n${renderLog}`, 'utf8');
          return;
        }

        // Exit 0 NÃO garante vídeo: valida que o arquivo existe e não está vazio
        let size = 0;
        try { size = (await stat(outputFile)).size; } catch {}
        if (size > 0) {
          app.log.info({ jobId, size }, 'Render complete');
          await writeFile(join(jobDir, 'done.txt'), 'ok', 'utf8');
        } else {
          app.log.error({ jobId }, 'Render terminou com exit 0 mas o vídeo está vazio/ausente');
          await writeFile(
            join(jobDir, 'error.txt'),
            `Render saiu com código 0 mas ${outputFile} ficou vazio ou ausente (${size} bytes).\n\n--- log ---\n${renderLog}`,
            'utf8'
          );
        }
      }
    );

    // Captura stdout/stderr do render para o log do job e para o console do container
    const onRenderChunk = (chunk) => {
      const text = chunk.toString();
      renderLog += text;
      process.stdout.write(`[render ${jobId.slice(0, 8)}] ${text}`);
    };
    proc.stdout?.on('data', onRenderChunk);
    proc.stderr?.on('data', onRenderChunk);

    reply.code(202).send({
      job_id: jobId,
      status_url: `/status/${jobId}`,
    });
  }
);

// ─── GET /status/:jobId ───────────────────────────────────────────────────────
app.get(
  '/status/:jobId',
  {
    schema: {
      summary: 'Verifica o status de um job de renderização',
      params: {
        type: 'object',
        properties: { jobId: { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            job_id: { type: 'string' },
            status: { type: 'string', enum: ['processing', 'done', 'error'] },
            download_url: { type: 'string' },
            error: { type: 'string' },
          },
        },
        404: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
      },
    },
  },
  async (req, reply) => {
    const { jobId } = req.params;
    const jobDir = join(WORK_DIR, jobId);

    if (!existsSync(jobDir)) {
      return reply.code(404).send({ error: 'Job não encontrado' });
    }

    if (existsSync(join(jobDir, 'done.txt'))) {
      return { job_id: jobId, status: 'done', download_url: `/download/${jobId}` };
    }

    if (existsSync(join(jobDir, 'error.txt'))) {
      const msg = await readFile(join(jobDir, 'error.txt'), 'utf8');
      return { job_id: jobId, status: 'error', error: msg };
    }

    return { job_id: jobId, status: 'processing' };
  }
);

// ─── GET /download/:jobId ─────────────────────────────────────────────────────
app.get(
  '/download/:jobId',
  {
    schema: {
      summary: 'Baixa o MP4 renderizado',
      params: {
        type: 'object',
        properties: { jobId: { type: 'string' } },
      },
    },
  },
  async (req, reply) => {
    const { jobId } = req.params;
    const videoPath = join(WORK_DIR, jobId, 'output', 'video.mp4');

    if (!existsSync(videoPath)) {
      return reply.code(404).send({ error: 'Vídeo não encontrado ou ainda em processamento' });
    }

    // Não serve arquivo vazio — sinaliza falha de render em vez de baixar 0 bytes
    const { size } = await stat(videoPath);
    if (size === 0) {
      return reply.code(409).send({ error: 'Render produziu um vídeo vazio. Veja GET /logs/' + jobId });
    }

    reply.header('Content-Type', 'video/mp4');
    reply.header('Content-Length', size);
    reply.header('Content-Disposition', `attachment; filename="video-${jobId}.mp4"`);

    // Limpa o job 1 min após o início do download
    setTimeout(() => rm(join(WORK_DIR, jobId), { recursive: true, force: true }), 60_000);

    // IMPORTANTE: em handler async, é preciso RETORNAR o stream/reply — senão o
    // Fastify resolve a promise com undefined e corta o corpo (download de 0 bytes).
    return reply.send(createReadStream(videoPath));
  }
);

// ─── GET /logs/:jobId ─────────────────────────────────────────────────────────
// Retorna o stdout/stderr capturado do hyperframes render, em texto puro.
app.get(
  '/logs/:jobId',
  {
    schema: {
      summary: 'Retorna o log do render (stdout/stderr) de um job',
      params: { type: 'object', properties: { jobId: { type: 'string' } } },
    },
  },
  async (req, reply) => {
    const logPath = join(WORK_DIR, req.params.jobId, 'render.log');
    if (!existsSync(logPath)) {
      return reply.code(404).send({ error: 'Log não encontrado (job inexistente ou ainda em processamento)' });
    }
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return reply.send(await readFile(logPath, 'utf8'));
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Docs disponíveis em http://localhost:${PORT}/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
