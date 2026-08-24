# POST /render

Submete uma composição HyperFrames para renderização assíncrona. Retorna imediatamente com um `job_id` — o vídeo é processado em background.

A composição pode vir de duas formas **mutuamente exclusivas**:

- **`html`** (com os opcionais `compositions` e `assets`) — envia a composição no corpo da requisição;
- **`preview_id`** — renderiza o diretório de um preview existente **como ele está no disco**, incluindo o que foi editado e salvo na Studio. Ver [preview.md](./preview.md).

Vale para um preview cuja Studio já foi encerrada: enquanto o diretório estiver em disco (24h), o `preview_id` continua renderizável — e, se você quiser **voltar a editar** antes de renderizar, `POST /preview {"preview_id": ...}` reabre a Studio sobre ele, no mesmo id (ver [preview.md § Reabrir um preview](./preview.md#reabrir-um-preview)).

## Request

**Method:** `POST`  
**Path:** `/render`  
**Content-Type:** `application/json`

### Body

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|-------|------|-------------|--------|-----------|
| `html` | `string` | Sim* | — | Conteúdo completo do `index.html` da composição HyperFrames. Mutuamente exclusivo com `preview_id` |
| `preview_id` | `string` | Sim* | — | UUID devolvido por `POST /preview`. Renderiza o diretório desse preview como está em disco, **com as edições salvas na Studio**. Mutuamente exclusivo com `html` |
| `compositions` | `array` | Não | `[]` | Arquivos de sub-composição adicionais (padrão modular via `data-composition-src`) |
| `compositions[].path` | `string` | Sim | — | Caminho relativo ao diretório do job, ex: `compositions/scene-1.html` |
| `compositions[].content` | `string` | Sim | — | Conteúdo do arquivo (HTML com `<template>`, `<style>` e `<script>` da cena) |
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) |
| `assets[].filename` | `string` | Sim | — | Nome do arquivo, ex: `narration.mp3`, `logo.png` |
| `assets[].base64` | `string` | Sim** | — | Conteúdo do arquivo codificado em base64 |
| `assets[].url` | `string` | Sim** | — | URL pública/assinada de um asset já hospedado (bucket/CDN) — o servidor baixa via `fetch` |
| `fps` | `integer` | Não | `30` | Frames por segundo do vídeo de saída |

**\*Informe `html` **ou** `preview_id`** — exatamente um dos dois. Os dois juntos, ou nenhum, retornam `400`.

**Cada asset precisa de `base64` **ou** `url`** (um dos dois, não ambos). `url` evita o overhead de ~33% do base64 e o limite de tamanho do JSON body — preferível para arquivos grandes ou quando o asset já está hospedado externamente.

Com `preview_id`, os assets **já estão** no diretório do preview (foram gravados lá pelo `POST /preview`), então `compositions` e `assets` não precisam ser reenviados — o payload fica minúsculo.

`compositions[].path` (e `assets[].filename`) são validados contra path traversal — não podem ser absolutos nem conter `..`. Uma tentativa é rejeitada com `400` antes de qualquer escrita em disco. O `preview_id` é validado contra o formato de UUID, o que também barra traversal.

### Exemplo de body (simples)

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá Mundo!</h1></div>",
  "fps": 30
}
```

### Exemplo de body (renderizando o que foi editado na Studio)

```json
{
  "preview_id": "550e8400-e29b-41d4-a716-446655440000",
  "fps": 30
}
```

Fluxo completo:

```
POST /preview                      → preview_url + preview_id
  ↓
abrir preview_url, editar e SALVAR na Studio
  ↓
POST /render { "preview_id": ... } → job_id
  ↓
GET /status/:job_id → GET /download/:job_id
```

O diretório do preview é **copiado** para o diretório do job, então o render fica independente: o preview pode continuar sendo editado ou expirar sem afetar um job já submetido.

Os arquivos de um preview sobrevivem por `PREVIEW_RETENTION_MS` (padrão 24h) mesmo depois do processo do studio morrer — inclusive quando ele foi substituído por um `POST /preview` mais novo.

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

### Exemplo de body (padrão modular, com `compositions`)

`index.html` fica fino — só declara os slots via `data-composition-src` — e cada cena vira um arquivo próprio em `compositions/`. O runtime `hyperframes` resolve `data-composition-src` nativamente: clona o `<template>` do arquivo referenciado para dentro do slot e registra `window.__timelines["scene-N"]` como já faz hoje. O servidor só materializa os arquivos no disco antes de rodar o CLI — sem `compositions` no body, o comportamento é idêntico ao de um `index.html` monolítico.

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\" data-composition-id=\"root\"><div data-composition-src=\"compositions/scene-1.html\" data-composition-id=\"scene-1\" data-start=\"0\" data-duration=\"3\" class=\"clip\"></div><div data-composition-src=\"compositions/scene-2.html\" data-composition-id=\"scene-2\" data-start=\"3\" data-duration=\"3\" class=\"clip\"></div><script>window.__timelines = { root: { duration: 6 } };</script></div>",
  "compositions": [
    {
      "path": "compositions/scene-1.html",
      "content": "<template><div data-composition-id=\"scene-1\" data-width=\"1920\" data-height=\"1080\"><h1 class=\"clip\" data-duration=\"3\">Cena 1</h1></div></template><script>window.__timelines = window.__timelines || {}; window.__timelines['scene-1'] = { duration: 3 };</script>"
    },
    {
      "path": "compositions/scene-2.html",
      "content": "<template><div data-composition-id=\"scene-2\" data-width=\"1920\" data-height=\"1080\"><h1 class=\"clip\" data-duration=\"3\">Cena 2</h1></div></template><script>window.__timelines = window.__timelines || {}; window.__timelines['scene-2'] = { duration: 3 };</script>"
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

### 400 Bad Request

Retornado quando um asset não tem `base64` nem `url`, o download da `url` falha (HTTP não-2xx, DNS, timeout etc), ou algum `compositions[].path`/`assets[].filename` é inválido (absoluto ou contendo `..`). Nenhum job é criado — o `jobDir` é limpo antes de responder.

```json
{ "error": "Falha ao baixar asset \"logo.png\" de https://meu-bucket.com/logo.png: HTTP 404" }
```

```json
{ "error": "Path inválido: \"../../etc/passwd\" (não pode ser absoluto nem conter \"..\")" }
```

Também retornado quando `html` e `preview_id` vêm juntos, quando nenhum dos dois é informado, ou quando o `preview_id` não tem formato de UUID:

```json
{ "error": "\"html\" e \"preview_id\" são mutuamente exclusivos" }
```

```json
{ "error": "Informe \"html\" ou \"preview_id\" (um dos dois)" }
```

```json
{ "error": "preview_id inválido: \"../../etc\"" }
```

### 404 Not Found

Retornado quando o `preview_id` informado não existe em disco — o preview expirou (`PREVIEW_RETENTION_MS`, padrão 24h) ou nunca foi criado.

```json
{ "error": "Preview \"550e8400-...\" não encontrado (expirado ou nunca criado). Crie um novo com POST /preview." }
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

### Renderizando as edições feitas na Studio

```bash
# 1. cria o preview e guarda o id
PREVIEW=$(curl -s -X POST http://localhost:3030/preview \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 class=\"clip\" data-duration=\"3\">Olá!</h1></div>"}')
PREVIEW_ID=$(echo "$PREVIEW" | jq -r '.preview_id')
open "$(echo "$PREVIEW" | jq -r '.preview_url')"   # editar e SALVAR na Studio

# 2. renderiza o que foi salvo
curl -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d "{\"preview_id\":\"$PREVIEW_ID\",\"fps\":30}"
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

1. Cria `jobDir`, salva `index.html`, materializa cada item de `compositions` (após validar o `path`) e resolve cada asset (`base64` decodificado ou `fetch(url)`) em disco — falha em qualquer composição ou asset limpa o `jobDir` e responde `400` antes de iniciar o render.
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
