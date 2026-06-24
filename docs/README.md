# HyperFrames Server — API Reference

REST API para renderização assíncrona de vídeos com HyperFrames (Chromium + FFmpeg).

## Base URL

```
http://localhost:3030
```

## Autenticação

Nenhuma. A API não requer autenticação.

## Formato

Todas as requisições e respostas usam `application/json`, exceto o endpoint de download que retorna `video/mp4`.

## Endpoints

| Método | Rota | Descrição | Documento |
|--------|------|-----------|-----------|
| `GET` | `/health` | Status do servidor | [health.md](./health.md) |
| `POST` | `/lint` | Valida composição sem renderizar (síncrono) | [lint.md](./lint.md) |
| `POST` | `/preview` | Cria preview ao vivo no browser | [preview.md](./preview.md) |
| `GET` | `/preview/:previewId` | Abre a página de preview | [preview.md](./preview.md) |
| `DELETE` | `/preview/:previewId` | Remove um preview | [preview.md](./preview.md) |
| `POST` | `/render` | Submete composição HTML para renderização | [render.md](./render.md) |
| `GET` | `/status/:jobId` | Verifica status de um job | [status.md](./status.md) |
| `GET` | `/download/:jobId` | Baixa o MP4 gerado | [download.md](./download.md) |
| `GET` | `/docs` | Swagger UI interativo | — |

## Fluxos típicos

### Lint (síncrono)

```
POST /lint   → valid: true/false + lista de erros (< 1s)
```

Use para validar a composição antes de qualquer outra chamada.

### Preview (instantâneo)

```
POST /preview   → recebe preview_url (201 Created)
      ↓
GET  /preview/:previewId → abre no browser com <hyperframes-player>
```

Use para visualizar e ajustar a composição antes de renderizar.

### Render (assíncrono)

```
1. POST /render        → recebe job_id (202 Accepted)
         ↓
2. GET  /status/:jobId → polling até status = "done" ou "error"
         ↓
3. GET  /download/:jobId → stream do arquivo MP4
```

### Exemplo completo em bash

```bash
BASE="http://localhost:3030"

# 1. Enviar composição
RESPONSE=$(curl -s -X POST "$BASE/render" \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>","fps":30}')

JOB_ID=$(echo "$RESPONSE" | jq -r '.job_id')
echo "Job iniciado: $JOB_ID"

# 2. Polling até concluir
while true; do
  STATUS=$(curl -s "$BASE/status/$JOB_ID" | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "error" ] && exit 1
  sleep 5
done

# 3. Baixar vídeo
curl -o "video-$JOB_ID.mp4" "$BASE/download/$JOB_ID"
echo "Vídeo salvo: video-$JOB_ID.mp4"
```

## Deploy

Para instruções de como subir o servidor em produção (Docker Compose, Coolify), veja [deploy.md](./deploy.md).
