# Preview

Endpoints para criar e encerrar previews ao vivo de composições HyperFrames.

O preview spawna o `hyperframes preview` (o studio interativo) em uma **porta dedicada** e retorna a URL pública para abrir no browser. Diferente do `/render`, nenhum vídeo é gerado — o studio processa a composição em tempo real.

**Apenas 1 preview ativo por vez.** Chamar `POST /preview` enquanto já existe um ativo encerra o anterior automaticamente.  
**Porta:** `PREVIEW_PORT` (padrão: `3031`) — deve estar exposta no Docker/firewall.  
**TTL:** o processo é encerrado automaticamente em **2 horas**.

---

## POST /preview

Encerra o preview anterior (se houver), salva a composição no disco, spawna o studio e retorna a URL pública.

### Request

**Method:** `POST`  
**Path:** `/preview`  
**Content-Type:** `application/json`

#### Body

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|-------|------|-------------|--------|-----------|
| `html` | `string` | Sim | — | Conteúdo do `index.html` da composição HyperFrames |
| `compositions` | `array` | Não | `[]` | Arquivos de sub-composição adicionais (padrão modular via `data-composition-src`) |
| `compositions[].path` | `string` | Sim | — | Caminho relativo ao diretório de sessão, ex: `compositions/scene-1.html` |
| `compositions[].content` | `string` | Sim | — | Conteúdo do arquivo (HTML com `<template>`, `<style>` e `<script>` da cena) |
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) |
| `assets[].filename` | `string` | Sim | — | Nome do arquivo, ex: `narration.mp3` |
| `assets[].base64` | `string` | Sim** | — | Conteúdo do arquivo codificado em base64 |
| `assets[].url` | `string` | Sim** | — | URL pública/assinada de um asset já hospedado (bucket/CDN) — o servidor baixa via `fetch` |

**Cada asset precisa de `base64` **ou** `url`** (um dos dois, não ambos). `url` evita o overhead de ~33% do base64 e o limite de tamanho do JSON body — preferível para arquivos grandes ou quando o asset já está hospedado externamente.

`compositions[].path` (e `assets[].filename`) são validados contra path traversal — não podem ser absolutos nem conter `..`. Uma tentativa é rejeitada com `400` antes de qualquer escrita em disco.

#### Exemplo de body

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>"
}
```

#### Com sub-composições (padrão modular)

`index.html` fica fino — só declara os slots via `data-composition-src` — e cada cena vira um arquivo próprio em `compositions/`. O runtime `hyperframes` resolve `data-composition-src` nativamente: clona o `<template>` do arquivo referenciado para dentro do slot e registra `window.__timelines["scene-N"]` como já faz hoje. O servidor só materializa os arquivos no disco antes de rodar o CLI.

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
  ]
}
```

#### Com assets em base64

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><audio src=\"narration.mp3\" data-duration=\"10\"/></div>",
  "assets": [
    {
      "filename": "narration.mp3",
      "base64": "//uQxAAAAAAAAAAAAAAAAAAAAAAA..."
    }
  ]
}
```

#### Com assets por URL

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><img src=\"logo.png\"/></div>",
  "assets": [
    {
      "filename": "logo.png",
      "url": "https://meu-bucket.com/logo.png"
    }
  ]
}
```

### Response

#### 201 Created

```json
{
  "preview_id": "550e8400-e29b-41d4-a716-446655440000",
  "preview_url": "http://meu-servidor.com:3031",
  "expires_in": "2 horas"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `preview_id` | `string` | UUID do preview — use para encerrar via DELETE |
| `preview_url` | `string` | URL pública do studio (valor de `PUBLIC_PREVIEW_URL`) |
| `expires_in` | `string` | Tempo até o processo ser encerrado automaticamente |

#### 400 Bad Request

Retornado quando um asset não tem `base64` nem `url`, o download da `url` falha (HTTP não-2xx, DNS, timeout etc), ou algum `compositions[].path`/`assets[].filename` é inválido (absoluto ou contendo `..`). Nenhum arquivo fica salvo em disco — o `previewDir` é limpo antes de responder.

```json
{ "error": "Falha ao baixar asset \"logo.png\" de https://meu-bucket.com/logo.png: HTTP 404" }
```

```json
{ "error": "Path inválido: \"../../etc/passwd\" (não pode ser absoluto nem conter \"..\")" }
```

#### 500 Internal Server Error

Retornado quando o `hyperframes preview` não iniciou em 30 segundos ou saiu com erro.

```json
{ "error": "hyperframes preview não iniciou em 30s" }
```

### Exemplo cURL

```bash
curl -s -X POST http://localhost:3030/preview \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>"
  }'
```

#### Extrair URL e abrir no browser (macOS)

```bash
URL=$(curl -s -X POST http://localhost:3030/preview \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Teste</h1></div>"}' \
  | jq -r '.preview_url')

open "$URL"
```

---

## DELETE /preview/:previewId

Encerra o studio, libera a porta e remove os arquivos do preview.

### Request

**Method:** `DELETE`  
**Path:** `/preview/:previewId`

#### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `previewId` | `string` | UUID retornado pelo `POST /preview` |

### Response

#### 200 OK

```json
{ "deleted": true }
```

#### 404 Not Found

Retornado quando o `previewId` não corresponde ao preview ativo (ou não há preview ativo).

```json
{ "error": "Preview não encontrado" }
```

### Exemplo cURL

```bash
curl -X DELETE http://localhost:3030/preview/550e8400-e29b-41d4-a716-446655440000
```

---

## Como funciona internamente

```
POST /preview
  ├── killActivePreview()
  │     ├── SIGTERM no processo anterior (se houver)
  │     ├── rm /tmp/hf-previews/{previewId anterior}/
  │     └── executa: hyperframes preview --kill-all  (limpa registry interno)
  ├── salva index.html em /tmp/hf-previews/{previewId}/
  ├── salva cada item de compositions (após validar path) em /tmp/hf-previews/{previewId}/{path}
  │     └── path inválido (absoluto ou com "..") → 400 (nenhum studio é spawnado)
  ├── salva cada asset (via base64 ou fetch(url)) em /tmp/hf-previews/{previewId}/
  │     └── falha em qualquer asset → rm do dir + 400 (nenhum studio é spawnado)
  ├── spawnPreview(dir, PREVIEW_PORT)
  │     ├── executa: hyperframes preview --port 3031 --no-open --force-new
  │     ├── aguarda linha "Studio  http://localhost:XXXX" no stdout (timeout: 30s)
  │     └── parseia a porta **real** (pode diferir de PREVIEW_PORT se houver conflito)
  ├── reconstrói preview_url com a porta real e PUBLIC_PREVIEW_URL
  ├── agenda killActivePreview() após PREVIEW_TTL_MS (2h)
  └── responde 201 com preview_url

DELETE /preview/:previewId
  └── killActivePreview() → SIGTERM + --kill-all + rm dir
```

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PREVIEW_PORT` | `3031` | Porta em que o studio escuta dentro do container |
| `PUBLIC_PREVIEW_URL` | `http://localhost:3031` | URL base retornada ao cliente como `preview_url` — deve ser a URL pública acessível pelo browser |

**Exemplo para produção no Coolify/VPS:**

```
PREVIEW_PORT=3031
PUBLIC_PREVIEW_URL=http://meu-vps.com:3031
```

A porta `3031` (ou o valor de `PREVIEW_PORT`) deve estar exposta no `docker-compose.yaml` e aberta no firewall.

---

## Notas

- **1 preview por vez:** qualquer chamada a `POST /preview` encerra o anterior — não há concorrência
- **Porta real pode diferir:** se `PREVIEW_PORT` estiver ocupada, o `hyperframes preview` escolhe outra porta; o servidor parseia a porta real do stdout e reconstrói `preview_url` automaticamente
- **`--kill-all`:** antes de cada preview, o servidor executa `hyperframes preview --kill-all` para limpar studios zumbis que o processo pai não conseguiu encerrar
- **TTL:** o processo é encerrado via SIGTERM após 2 horas; use `DELETE` para encerrar antes
- Uso típico: visualizar e ajustar a composição antes de chamar `POST /render` para gerar o MP4 final
