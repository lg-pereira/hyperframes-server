# GET /download/:jobId

Baixa o arquivo MP4 gerado após uma renderização concluída. O arquivo é transmitido como stream diretamente ao cliente.

## Request

**Method:** `GET`  
**Path:** `/download/:jobId`

### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `jobId` | `string` | UUID do job retornado pelo `POST /render` |

## Response

### 200 OK — Stream de vídeo

Retorna o arquivo MP4 como stream binário.

**Headers da resposta:**

| Header | Valor |
|--------|-------|
| `Content-Type` | `video/mp4` |
| `Content-Disposition` | `attachment; filename="video-{jobId}.mp4"` |

O corpo da resposta é o conteúdo binário do arquivo `.mp4`.

### 404 Not Found

O vídeo não existe ou ainda não terminou de ser renderizado.

```json
{
  "error": "Vídeo não encontrado ou ainda em processamento"
}
```

## Exemplos cURL

### Salvar vídeo com nome automático

```bash
curl -O http://localhost:3030/download/550e8400-e29b-41d4-a716-446655440000
# Salva como: video-550e8400-e29b-41d4-a716-446655440000.mp4
```

### Salvar com nome personalizado

```bash
curl -o meu-video.mp4 http://localhost:3030/download/550e8400-e29b-41d4-a716-446655440000
```

### Fluxo completo: render → poll → download

```bash
BASE="http://localhost:3030"

# 1. Submeter render
JOB_ID=$(curl -s -X POST "$BASE/render" \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Teste</h1></div>"}' \
  | jq -r '.job_id')

echo "Job: $JOB_ID"

# 2. Aguardar conclusão
while true; do
  STATUS=$(curl -s "$BASE/status/$JOB_ID" | jq -r '.status')
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "error" ] && { echo "Erro no render"; exit 1; }
  sleep 5
done

# 3. Baixar vídeo
curl -o "video-$JOB_ID.mp4" "$BASE/download/$JOB_ID"
echo "Download concluído: video-$JOB_ID.mp4"
```

## Notas

- Chame este endpoint **somente após** [GET /status/:jobId](./status.md) retornar `"status": "done"`
- O job directory em `/tmp/hf-jobs/{jobId}/` é **deletado automaticamente 60 segundos** após o download — faça o download apenas uma vez ou salve o arquivo localmente
- Se chamar o endpoint enquanto o render ainda está em andamento, recebe `404`
- O nome do arquivo no `Content-Disposition` segue o padrão `video-{jobId}.mp4`
