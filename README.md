# hyperframes-server

API REST para renderização de vídeos com [HyperFrames](https://github.com/heygen-com/hyperframes) (Chromium + FFmpeg), construída com Fastify.

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/health` | Status do servidor |
| GET | `/docs` | Documentação Swagger interativa |
| POST | `/render` | Envia composição HTML para renderizar |
| GET | `/status/:jobId` | Verifica status do job |
| GET | `/download/:jobId` | Baixa o MP4 gerado |

## Uso rápido

### 1. Enviar uma composição para renderizar

```bash
curl -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>",
    "fps": 30
  }'
```

Resposta:
```json
{
  "job_id": "uuid-aqui",
  "status_url": "/status/uuid-aqui"
}
```

### 2. Verificar o status

```bash
curl http://localhost:3030/status/<job_id>
```

Resposta quando pronto:
```json
{
  "job_id": "uuid-aqui",
  "status": "done",
  "download_url": "/download/uuid-aqui"
}
```

### 3. Baixar o vídeo

```bash
curl -O http://localhost:3030/download/<job_id>
```

### Enviar assets (áudio, imagens)

```bash
curl -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><audio src=\"narration.mp3\" data-duration=\"10\"/></div>",
    "assets": [
      {
        "filename": "narration.mp3",
        "base64": "<base64 do arquivo>"
      }
    ],
    "fps": 30
  }'
```

## Deploy no Coolify

Ver instruções em [`DEPLOY.md`](./DEPLOY.md).

## Stack

- **Runtime**: Node.js 22 (Debian-slim)
- **Framework**: Fastify 4
- **Renderer**: HyperFrames CLI (Chromium headless + FFmpeg)
- **Docs**: Swagger UI em `/docs`
