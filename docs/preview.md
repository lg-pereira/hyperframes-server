# Preview

Endpoints para criar e gerenciar previews ao vivo de composições HyperFrames.

Ao contrário do `/render`, o preview **não gera vídeo** — ele spawna o `hyperframes preview` (o studio interativo do HyperFrames) em um processo isolado e proxia o acesso via URL do servidor. O resultado é o studio completo abrindo no browser, com playback, scrubbing e hot-reload.

**Armazenamento:** `/tmp/hf-previews/{previewId}/`  
**TTL:** processos são encerrados automaticamente em **2 horas**.  
**Concorrência:** até **100 previews simultâneos** (portas internas `3100–3199`, configuráveis por env).

---

## POST /preview

Salva a composição, spawna o `hyperframes preview` em uma porta interna e retorna a URL proxiada para abrir no browser.

### Request

**Method:** `POST`  
**Path:** `/preview`  
**Content-Type:** `application/json`

#### Body

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|-------|------|-------------|--------|-----------|
| `html` | `string` | Sim | — | Conteúdo do `index.html` da composição HyperFrames |
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) em base64 |
| `assets[].filename` | `string` | Sim* | — | Nome do arquivo, ex: `narration.mp3` |
| `assets[].base64` | `string` | Sim* | — | Conteúdo do arquivo codificado em base64 |

*Obrigatório quando `assets` está presente.

#### Exemplo de body

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>"
}
```

#### Com assets

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

### Response

#### 201 Created

```json
{
  "preview_id": "550e8400-e29b-41d4-a716-446655440000",
  "preview_url": "/preview/550e8400-e29b-41d4-a716-446655440000/",
  "expires_in": "2 horas"
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `preview_id` | `string` | UUID único do preview |
| `preview_url` | `string` | Caminho para abrir no browser (note a `/` final) |
| `expires_in` | `string` | Tempo até o processo ser encerrado |

#### 500 Internal Server Error

Retornado quando o limite de previews simultâneos foi atingido (todas as 100 portas ocupadas) ou quando o processo `hyperframes preview` falhou ao iniciar.

```json
{ "error": "Sem portas disponíveis — limite de previews simultâneos atingido" }
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

open "http://localhost:3030$URL"
```

---

## GET /preview/:previewId/*

Proxy reverso para o studio `hyperframes preview` rodando na porta interna do processo. Qualquer sub-rota é repassada ao processo — o studio do HyperFrames pode servir assets, websockets e rotas internas normalmente.

### Request

**Method:** `GET`  
**Path:** `/preview/:previewId/` (e qualquer sub-rota, ex: `/preview/:previewId/assets/logo.png`)

#### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `previewId` | `string` | UUID retornado pelo `POST /preview` |

### Response

#### 200 OK

Resposta proxiada do `hyperframes preview` — normalmente a página HTML do studio.

#### 404 Not Found

```json
{ "error": "Preview não encontrado ou expirado" }
```

### Exemplo

```bash
# Abrir o studio no browser (macOS)
open "http://localhost:3030/preview/550e8400-e29b-41d4-a716-446655440000/"
```

---

## DELETE /preview/:previewId

Encerra o processo `hyperframes preview`, libera a porta interna e remove os arquivos. Use quando quiser fechar o preview antes do TTL de 2 horas.

### Request

**Method:** `DELETE`  
**Path:** `/preview/:previewId`

#### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `previewId` | `string` | UUID do preview a encerrar |

### Response

#### 200 OK

```json
{ "deleted": true }
```

#### 404 Not Found

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
  ├── salva index.html + assets em /tmp/hf-previews/{previewId}/
  ├── acquirePort() → pega uma porta do pool (3100–3199)
  ├── spawnPreview() → executa: npx hyperframes preview <dir> --port <porta> --no-open
  │     └── aguarda "running at" no stdout/stderr (timeout: 30s)
  └── registra em activePreviews: { proc, port, timer }

GET /preview/:previewId/*
  └── proxy via @fastify/reply-from → http://localhost:{porta}/{sub-rota}

DELETE /preview/:previewId  (ou TTL expirar)
  ├── proc.kill('SIGTERM')
  ├── availablePorts.add(porta)   ← porta retorna ao pool
  ├── activePreviews.delete(previewId)
  └── rm /tmp/hf-previews/{previewId}/
```

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PREVIEW_PORT_MIN` | `3100` | Primeira porta do pool interno |
| `PREVIEW_PORT_MAX` | `3199` | Última porta do pool interno (máx: `MAX - MIN + 1` previews simultâneos) |

---

## Notas

- O `preview_url` termina com `/` — necessário para o studio carregar sub-recursos corretamente
- O processo `hyperframes preview` tem **30 segundos** para iniciar; se não responder, a requisição retorna 500
- Previews são encerrados via **SIGTERM** — o processo tem chance de limpar estado antes de morrer
- **Limite de concorrência:** 100 previews simultâneos por padrão. Ajuste `PREVIEW_PORT_MIN`/`PREVIEW_PORT_MAX` no ambiente para ampliar
- Uso típico: visualizar e ajustar a composição antes de chamar `POST /render` para gerar o MP4 final
