import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';

const PORT = 3030;
const HOST = '0.0.0.0';
const WORK_DIR = '/tmp/hf-jobs';

await mkdir(WORK_DIR, { recursive: true });

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
    execFile(
      'npx',
      ['hyperframes', 'render',
        '--input', join(jobDir, 'index.html'),
        '--output', outputFile,
        '--fps', String(fps),
        '--workers', 'auto',
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
