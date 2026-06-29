# GET /logs/:jobId

Retorna o stdout/stderr capturado do processo `hyperframes render` em texto puro. Útil para diagnosticar falhas quando o status é `error` ou quando o download retorna `409 Conflict`.

## Request

**Method:** `GET`  
**Path:** `/logs/:jobId`

### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `jobId` | `string` | UUID do job retornado pelo `POST /render` |

## Response

### 200 OK

Retorna o conteúdo do `render.log` em texto puro.

**Content-Type:** `text/plain; charset=utf-8`

```
[render] Launching Chromium...
[render] Frame 1/90 captured
[render] Frame 2/90 captured
...
[render] Encoding video with FFmpeg
[render] Done: /tmp/hf-jobs/550e8.../output/video.mp4
```

### 404 Not Found

O job não existe, ainda não iniciou o render (log ainda não foi criado), ou já foi removido após o download.

```json
{ "error": "Log não encontrado (job inexistente ou ainda em processamento)" }
```

## Exemplos cURL

### Ver log diretamente no terminal

```bash
curl http://localhost:3030/logs/550e8400-e29b-41d4-a716-446655440000
```

### Diagnóstico após status `error`

```bash
BASE="http://localhost:3030"
JOB_ID="550e8400-e29b-41d4-a716-446655440000"

STATUS=$(curl -s "$BASE/status/$JOB_ID" | jq -r '.status')

if [ "$STATUS" = "error" ]; then
  echo "=== Render falhou. Log do processo: ==="
  curl -s "$BASE/logs/$JOB_ID"
fi
```

### Diagnóstico após 409 no download

```bash
BASE="http://localhost:3030"
JOB_ID="550e8400-e29b-41d4-a716-446655440000"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/download/$JOB_ID")

if [ "$HTTP_CODE" = "409" ]; then
  echo "=== Vídeo vazio. Log do processo: ==="
  curl -s "$BASE/logs/$JOB_ID"
fi
```

## Notas

- O log é criado **ao final do render** (com sucesso ou erro) — enquanto o job ainda está `processing`, este endpoint retorna 404
- O arquivo `render.log` contém todo o stdout/stderr do processo `hyperframes render`, incluindo progresso de frames e mensagens do FFmpeg
- Em caso de erro, o `render.log` também está embutido no campo `error` retornado por `GET /status/:jobId` (após `--- log ---`)
- O log é removido junto com o job: **60 segundos após o download** do vídeo
