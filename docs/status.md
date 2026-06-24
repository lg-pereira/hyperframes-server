# GET /status/:jobId

Verifica o status de um job de renderização. Use este endpoint para fazer polling após chamar [POST /render](./render.md).

## Request

**Method:** `GET`  
**Path:** `/status/:jobId`

### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `jobId` | `string` | UUID do job retornado pelo `POST /render` |

## Response

### 200 OK

Retornado enquanto o job existe (em qualquer estado).

#### Status: `processing`

O vídeo ainda está sendo renderizado.

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing"
}
```

#### Status: `done`

Renderização concluída. O vídeo está pronto para download.

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "done",
  "download_url": "/download/550e8400-e29b-41d4-a716-446655440000"
}
```

#### Status: `error`

A renderização falhou.

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "error",
  "error": "Command failed: npx hyperframes render ..."
}
```

### 404 Not Found

O job não existe ou já foi removido (jobs são deletados 60 segundos após o download).

```json
{
  "error": "Job não encontrado"
}
```

### Campos da resposta

| Campo | Tipo | Presente quando | Descrição |
|-------|------|-----------------|-----------|
| `job_id` | `string` | Sempre (200) | UUID do job |
| `status` | `string` | Sempre (200) | `"processing"`, `"done"` ou `"error"` |
| `download_url` | `string` | `status = "done"` | Caminho para baixar o MP4 |
| `error` | `string` | `status = "error"` | Mensagem de erro do processo de render |

## Exemplos cURL

### Verificação única

```bash
curl http://localhost:3030/status/550e8400-e29b-41d4-a716-446655440000
```

### Polling em loop (bash)

```bash
JOB_ID="550e8400-e29b-41d4-a716-446655440000"

while true; do
  RESPONSE=$(curl -s "http://localhost:3030/status/$JOB_ID")
  STATUS=$(echo "$RESPONSE" | jq -r '.status')

  echo "$(date '+%H:%M:%S') — Status: $STATUS"

  if [ "$STATUS" = "done" ]; then
    DOWNLOAD_URL=$(echo "$RESPONSE" | jq -r '.download_url')
    echo "Pronto! Download em: http://localhost:3030$DOWNLOAD_URL"
    break
  fi

  if [ "$STATUS" = "error" ]; then
    ERROR=$(echo "$RESPONSE" | jq -r '.error')
    echo "Erro no render: $ERROR"
    exit 1
  fi

  sleep 5
done
```

### Polling com timeout (bash)

```bash
JOB_ID="550e8400-e29b-41d4-a716-446655440000"
MAX_WAIT=600  # 10 minutos
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(curl -s "http://localhost:3030/status/$JOB_ID" | jq -r '.status')

  case "$STATUS" in
    done)    echo "Concluído!"; break ;;
    error)   echo "Falhou."; exit 1 ;;
    processing) sleep 5; ELAPSED=$((ELAPSED + 5)) ;;
    *)       echo "Job não encontrado."; exit 1 ;;
  esac
done
```

## Notas

- Recomenda-se um intervalo de **3 a 10 segundos** entre cada poll para não sobrecarregar o servidor
- Jobs são automaticamente removidos **60 segundos após o download** — após esse tempo, o status retorna 404
- O tempo médio de renderização varia com a duração e complexidade da composição; o timeout máximo é de **10 minutos**
