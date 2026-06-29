import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
const PORT = 3030;
const HOST = '0.0.0.0';
const WORK_DIR = '/tmp/hf-jobs';
const PREVIEW_DIR = '/tmp/hf-previews';

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

function killActivePreview() {
  if (!activePreview) return;
  clearTimeout(activePreview.timer);
  try { activePreview.proc.kill('SIGTERM'); } catch {}
  rm(join(PREVIEW_DIR, activePreview.previewId), { recursive: true, force: true }).catch(() => {});
  activePreview = null;
}

// Spawna hyperframes preview no diretório da composição e aguarda o studio ficar pronto
function spawnPreview(dir, port) {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      'npx',
      ['hyperframes', 'preview', '--port', String(port), '--no-open'],
      { cwd: dir, timeout: 0 }   // cwd = projeto; sem argumento DIR, usa o diretório atual
    );

    const readyTimeout = setTimeout(
      () => { proc.kill(); reject(new Error('hyperframes preview não iniciou em 30s')); },
      30_000
    );

    const onChunk = (chunk) => {
      const text = chunk.toString();
      if (text.includes('running at') || text.includes(`localhost:${port}`) || text.includes('Studio')) {
        clearTimeout(readyTimeout);
        resolve(proc);
      }
    };

    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.on('error', (err) => { clearTimeout(readyTimeout); reject(err); });
    proc.on('exit', (code) => {
      if (code != null && code !== 0) {
        clearTimeout(readyTimeout);
        reject(new Error(`hyperframes preview saiu com código ${code}`));
      }
    });
  });
}

await mkdir(WORK_DIR, { recursive: true });
await mkdir(PREVIEW_DIR, { recursive: true });

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
          assets: {
            type: 'array',
            description: 'Arquivos adicionais (áudio, imagens) em base64',
            items: {
              type: 'object',
              required: ['filename', 'base64'],
              properties: {
                filename: { type: 'string' },
                base64: { type: 'string' },
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
    const { html, assets = [] } = req.body;

    // Encerra qualquer preview anterior antes de iniciar um novo
    killActivePreview();

    const previewId = randomUUID();
    const previewDir = join(PREVIEW_DIR, previewId);
    await mkdir(previewDir, { recursive: true });

    await writeFile(join(previewDir, 'index.html'), html, 'utf8');
    for (const asset of assets) {
      await writeFile(join(previewDir, asset.filename), Buffer.from(asset.base64, 'base64'));
    }

    // Estrutura mínima de projeto necessária para o hyperframes preview reconhecer o diretório
    await writeFile(join(previewDir, 'hyperframes.json'), JSON.stringify({ version: '1' }), 'utf8');
    await writeFile(join(previewDir, 'meta.json'), JSON.stringify({ name: previewId, duration: 10 }), 'utf8');

    let proc;
    try {
      proc = await spawnPreview(previewDir, PREVIEW_PORT);
    } catch (err) {
      await rm(previewDir, { recursive: true, force: true });
      return reply.code(500).send({ error: err.message });
    }

    const timer = setTimeout(() => killActivePreview(), PREVIEW_TTL_MS);
    activePreview = { proc, previewId, timer };

    app.log.info({ previewId, port: PREVIEW_PORT }, 'Preview started');

    reply.code(201).send({
      preview_id: previewId,
      preview_url: PUBLIC_PREVIEW_URL,
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
    killActivePreview();
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
          'npx',
          ['hyperframes', 'lint', lintDir, '--json'],
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
          assets: {
            type: 'array',
            description: 'Arquivos adicionais (áudio, imagens) em base64',
            items: {
              type: 'object',
              required: ['filename', 'base64'],
              properties: {
                filename: { type: 'string', description: 'Nome do arquivo, ex: narration.mp3' },
                base64: { type: 'string', description: 'Conteúdo do arquivo em base64' },
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
    const { html, assets = [], fps = 30 } = req.body;

    const jobId = randomUUID();
    const jobDir = join(WORK_DIR, jobId);
    const outputDir = join(jobDir, 'output');

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(jobDir, 'index.html'), html, 'utf8');

    for (const asset of assets) {
      const buf = Buffer.from(asset.base64, 'base64');
      await writeFile(join(jobDir, asset.filename), buf);
    }

    const outputFile = join(outputDir, 'video.mp4');

    // Render em background — não bloqueia a resposta
    // CLI: hyperframes render [DIR] -o <output> -f <fps> -w <workers>
    execFile(
      'npx',
      ['hyperframes', 'render', jobDir,
        '-o', outputFile,
        '-f', String(fps),
        '-w', 'auto',
        '--no-browser-gpu',
      ],
      { cwd: jobDir, timeout: 10 * 60 * 1000 }, // timeout 10 min
      async (err) => {
        if (err) {
          app.log.error({ jobId, err: err.message }, 'Render failed');
          await writeFile(join(jobDir, 'error.txt'), err.message, 'utf8');
        } else {
          app.log.info({ jobId }, 'Render complete');
          await writeFile(join(jobDir, 'done.txt'), 'ok', 'utf8');
        }
      }
    );

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

    reply.header('Content-Type', 'video/mp4');
    reply.header('Content-Disposition', `attachment; filename="video-${jobId}.mp4"`);

    const stream = createReadStream(videoPath);
    reply.send(stream);

    // Limpa o job 1 min após o download
    setTimeout(() => rm(join(WORK_DIR, jobId), { recursive: true, force: true }), 60_000);
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
