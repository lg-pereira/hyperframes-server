# POST /render

Submete uma composição HyperFrames para renderização assíncrona. Retorna imediatamente com um `job_id` — o vídeo é processado em background.

## Request

**Method:** `POST`  
**Path:** `/render`  
**Content-Type:** `application/json`

### Body

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|-------|------|-------------|--------|-----------|
| `html` | `string` | Sim | — | Conteúdo completo do `index.html` da composição HyperFrames |
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) codificados em base64 |
| `assets[].filename` | `string` | Sim* | — | Nome do arquivo, ex: `narration.mp3`, `logo.png` |
| `assets[].base64` | `string` | Sim* | — | Conteúdo do arquivo codificado em base64 |
| `fps` | `integer` | Não | `30` | Frames por segundo do vídeo de saída |

*Obrigatório quando `assets` está presente.

### Exemplo de body (simples)

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá Mundo!</h1></div>",
  "fps": 30
}
```

### Exemplo de body (com assets)

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><audio src=\"narration.mp3\" data-duration=\"10\"/><img src=\"logo.png\"/></div>",
  "assets": [
    {
      "filename": "narration.mp3",
      "base64": "//uQxAAAAAAAAAAAAAAAAAAAAAAA..."
    },
    {
      "filename": "logo.png",
      "base64": "iVBORw0KGgoAAAANSUhEUgAA..."
    }
  ],
  "fps": 30
}
```

## Response

### 202 Accepted

Job criado com sucesso. O processamento ocorre em background.

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status_url": "/status/550e8400-e29b-41d4-a716-446655440000"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `job_id` | `string` | UUID único do job, usado para polling e download |
| `status_url` | `string` | Caminho para verificar o status do job |

## Exemplos cURL

### Renderização simples

```bash
curl -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá Mundo!</h1></div>",
    "fps": 30
  }'
```

### Com arquivo de áudio

```bash
# Converter arquivo para base64
AUDIO_B64=$(base64 -i narration.mp3)

curl -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d "{
    \"html\": \"<div data-width=\\\"1920\\\" data-height=\\\"1080\\\"><audio src=\\\"narration.mp3\\\" data-duration=\\\"10\\\"/></div>\",
    \"assets\": [{
      \"filename\": \"narration.mp3\",
      \"base64\": \"$AUDIO_B64\"
    }],
    \"fps\": 30
  }"
```

### Com jq para extrair o job_id

```bash
JOB_ID=$(curl -s -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Teste</h1></div>"}' \
  | jq -r '.job_id')

echo "Job ID: $JOB_ID"
```

## Notas

- **Assíncrono:** a resposta `202` é imediata — o vídeo ainda não está pronto
- **Timeout:** o render é cancelado automaticamente após **10 minutos**
- **Workers:** o HyperFrames usa `--workers auto` (detecta núcleos disponíveis)
- **Armazenamento temporário:** os arquivos do job ficam em `/tmp/hf-jobs/{jobId}/`
- Após enviar o render, use [GET /status/:jobId](./status.md) para acompanhar o progresso
