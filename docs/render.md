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
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) |
| `assets[].filename` | `string` | Sim | — | Nome do arquivo, ex: `narration.mp3`, `logo.png` |
| `assets[].base64` | `string` | Sim** | — | Conteúdo do arquivo codificado em base64 |
| `assets[].url` | `string` | Sim** | — | URL pública/assinada de um asset já hospedado (bucket/CDN) — o servidor baixa via `fetch` |
| `fps` | `integer` | Não | `30` | Frames por segundo do vídeo de saída |

**Cada asset precisa de `base64` **ou** `url`** (um dos dois, não ambos). `url` evita o overhead de ~33% do base64 e o limite de tamanho do JSON body — preferível para arquivos grandes ou quando o asset já está hospedado externamente.

### Exemplo de body (simples)

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá Mundo!</h1></div>",
  "fps": 30
}
```

### Exemplo de body (com assets em base64)

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

### Exemplo de body (com assets por URL)

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><audio src=\"narration.mp3\" data-duration=\"10\"/><img src=\"logo.png\"/></div>",
  "assets": [
    {
      "filename": "narration.mp3",
      "url": "https://meu-bucket.com/narration.mp3"
    },
    {
      "filename": "logo.png",
      "url": "https://meu-bucket.com/logo.png"
    }
  ],
  "fps": 30
}
```

Os dois formatos podem ser misturados no mesmo array — cada asset é resolvido independentemente.

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

### 400 Bad Request

Retornado quando um asset não tem `base64` nem `url`, ou o download da `url` falha (HTTP não-2xx, DNS, timeout etc). Nenhum job é criado — o `jobDir` é limpo antes de responder.

```json
{ "error": "Falha ao baixar asset \"logo.png\" de https://meu-bucket.com/logo.png: HTTP 404" }
```

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

### Com asset por URL (bucket/CDN externo)

```bash
curl -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><img src=\"logo.png\"/></div>",
    "assets": [{
      "filename": "logo.png",
      "url": "https://meu-bucket.com/logo.png"
    }],
    "fps": 30
  }'
```

### Extrair o job_id com jq

```bash
JOB_ID=$(curl -s -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Teste</h1></div>"}' \
  | jq -r '.job_id')

echo "Job ID: $JOB_ID"
```

## Como funciona internamente

1. Cria `jobDir`, salva `index.html` e resolve cada asset (`base64` decodificado ou `fetch(url)`) em disco — falha em qualquer asset limpa o `jobDir` e responde `400` antes de iniciar o render.
2. Executa o binário local do HyperFrames em background:

```
hyperframes render <jobDir> -o <output.mp4> -f <fps> -w <workers> --no-browser-gpu
```

- **stdout/stderr** são capturados e salvos em `render.log` no diretório do job
- Ao terminar, o servidor **valida o tamanho do arquivo** — exit 0 não garante vídeo válido
- Se o arquivo estiver vazio ou ausente mesmo com exit 0, o job é marcado como `error`
- Em caso de erro, o `error.txt` inclui a mensagem e o conteúdo do `render.log`

## Variável de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `RENDER_WORKERS` | `auto` | Nº de workers paralelos do render. Em ARM pode compensar fixar (ex: `4`) |

## Notas

- **Assíncrono:** a resposta `202` é imediata — o vídeo ainda não está pronto
- **Timeout:** o render é cancelado automaticamente após **10 minutos**
- **Logs:** o stdout/stderr do processo fica disponível em `GET /logs/:jobId` enquanto o job existir
- Após enviar o render, use [GET /status/:jobId](./status.md) para acompanhar o progresso
- Se o status for `error`, consulte [GET /logs/:jobId](./logs.md) para ver o output completo do render
