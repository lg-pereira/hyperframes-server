# Preview

Endpoints para criar e encerrar previews ao vivo de composições HyperFrames.

O preview spawna o `hyperframes preview` (o studio interativo) em uma **porta dedicada** e retorna a URL pública para abrir no browser. Diferente do `/render`, nenhum vídeo é gerado — o studio processa a composição em tempo real.

A Studio é servida **por esta porta (3030)**, via proxy, para que o servidor consiga injetar o polyfill de secure context que faz **salvar edições** funcionar em HTTP puro — ver [deploy.md § Edição na Studio](./deploy.md#edição-na-studio-salvar--como-funciona). O que você salvar ali pode ser renderizado direto com [`POST /render` + `preview_id`](./render.md).

**Apenas 1 preview ativo por vez.** Chamar `POST /preview` enquanto já existe um ativo encerra o anterior automaticamente.  
**Porta do studio:** `PREVIEW_PORT` (padrão: `3031`) — acesso direto/diagnóstico, **sem** o polyfill.  
**TTL do processo:** encerrado automaticamente em **2 horas**.  
**Retenção dos arquivos:** os arquivos do preview (incluindo o que a Studio salvou) sobrevivem por `PREVIEW_RETENTION_MS` (padrão **24 horas**), mesmo depois do processo morrer — é o que permite **reabrir** (`POST /preview` com `preview_id`) ou renderizar por `preview_id` mais tarde.

---

## POST /preview

Encerra o preview anterior (se houver), spawna o studio e retorna a URL pública. A composição vem de uma de duas formas **mutuamente exclusivas**:

- **`html`** (com os opcionais `compositions` e `assets`) — cria um preview novo, com `preview_id` novo;
- **`preview_id`** — **reabre** a Studio sobre um diretório que ainda está em disco, no lugar e com o mesmo id, preservando as edições salvas nele. Ver [Reabrir um preview](#reabrir-um-preview).

### Request

**Method:** `POST`  
**Path:** `/preview`  
**Content-Type:** `application/json`

#### Body

| Campo | Tipo | Obrigatório | Padrão | Descrição |
|-------|------|-------------|--------|-----------|
| `html` | `string` | Sim* | — | Conteúdo do `index.html` da composição HyperFrames. Mutuamente exclusivo com `preview_id` |
| `preview_id` | `string` | Sim* | — | UUID de um preview ainda retido em disco (ver `GET /preview`). Reabre a Studio sobre esse diretório, **com as edições salvas**, mantendo o mesmo id. Mutuamente exclusivo com `html` |
| `compositions` | `array` | Não | `[]` | Arquivos de sub-composição adicionais (padrão modular via `data-composition-src`) |
| `compositions[].path` | `string` | Sim | — | Caminho relativo ao diretório de sessão, ex: `compositions/scene-1.html` |
| `compositions[].content` | `string` | Sim | — | Conteúdo do arquivo (HTML com `<template>`, `<style>` e `<script>` da cena) |
| `assets` | `array` | Não | `[]` | Arquivos adicionais (áudio, imagens) |
| `assets[].filename` | `string` | Sim | — | Nome do arquivo, ex: `narration.mp3` |
| `assets[].base64` | `string` | Sim** | — | Conteúdo do arquivo codificado em base64 |
| `assets[].url` | `string` | Sim** | — | URL pública/assinada de um asset já hospedado (bucket/CDN) — o servidor baixa via `fetch` |

**\*Informe `html` **ou** `preview_id`** — exatamente um dos dois. Os dois juntos, ou nenhum, retornam `400`.

**Cada asset precisa de `base64` **ou** `url`** (um dos dois, não ambos). `url` evita o overhead de ~33% do base64 e o limite de tamanho do JSON body — preferível para arquivos grandes ou quando o asset já está hospedado externamente.

Com `preview_id`, `compositions` e `assets` **não podem ser reenviados** (`400`): esses arquivos já estão no diretório do preview. Para trocar arquivos, crie um preview novo com `html`.

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
  "preview_url": "http://meu-servidor.com:3030/",
  "preview_url_direct": "http://meu-servidor.com:3031",
  "expires_in": "2 horas",
  "reused": false
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `preview_id` | `string` | UUID do preview — use para encerrar via DELETE **e para renderizar as edições** via `POST /render` |
| `preview_url` | `string` | **URL para abrir a Studio.** Com `PUBLIC_BASE_URL` definida, aponta para a Studio proxiada por esta porta, onde salvar edições funciona. Sem ela, cai no valor de `PUBLIC_PREVIEW_URL` (porta do studio, sem polyfill) |
| `preview_url_direct` | `string` | URL da porta do studio (`PUBLIC_PREVIEW_URL`), para acesso direto/diagnóstico — **sem** o polyfill |
| `expires_in` | `string` | Tempo até o processo ser encerrado automaticamente |
| `reused` | `boolean` | `true` quando a Studio foi **reaberta** sobre um diretório existente (`preview_id`); `false` quando o preview foi criado do zero a partir de `html` |

#### 400 Bad Request

Retornado quando: nem `html` nem `preview_id` foi informado (ou os dois juntos); o `preview_id` não tem formato de UUID; `compositions`/`assets` vieram junto com `preview_id`; um asset não tem `base64` nem `url`; o download da `url` falha (HTTP não-2xx, DNS, timeout etc); ou algum `compositions[].path`/`assets[].filename` é inválido (absoluto ou contendo `..`). No caminho `html`, nenhum arquivo fica salvo em disco — o `previewDir` é limpo antes de responder.

```json
{ "error": "\"html\" e \"preview_id\" são mutuamente exclusivos" }
```

```json
{ "error": "Falha ao baixar asset \"logo.png\" de https://meu-bucket.com/logo.png: HTTP 404" }
```

```json
{ "error": "Path inválido: \"../../etc/passwd\" (não pode ser absoluto nem conter \"..\")" }
```

#### 404 Not Found

Só no caminho `preview_id`: o UUID é válido mas o diretório não está mais em disco (expirou pela retenção, foi apagado com `?purge=true`, ou nunca existiu).

```json
{ "error": "Preview \"550e8400-e29b-41d4-a716-446655440000\" não encontrado (expirado ou nunca criado). Crie um novo com POST /preview {\"html\": ...}." }
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

### Reabrir um preview

O processo da Studio morre por vários motivos — TTL de 2h, `DELETE`, um `POST /preview` novo, restart do container, crash. Os **arquivos**, porém, ficam por 24h (`PREVIEW_RETENTION_MS`), com tudo que foi salvo na Studio. Reabrir sobe a Studio de novo sobre esse mesmo diretório, **no lugar e com o mesmo `preview_id`** — nada é copiado e nenhuma edição é perdida.

```bash
# 1. quais previews ainda estão em disco?
curl -s http://localhost:3030/preview | jq '.stored'

# 2. reabrir um deles (mesmo id de volta, reused: true)
curl -s -X POST http://localhost:3030/preview \
  -H "Content-Type: application/json" \
  -d '{"preview_id":"550e8400-e29b-41d4-a716-446655440000"}'

# 3. editar na Studio e renderizar com o MESMO id
curl -s -X POST http://localhost:3030/render \
  -H "Content-Type: application/json" \
  -d '{"preview_id":"550e8400-e29b-41d4-a716-446655440000"}'
```

Detalhes que valem saber:

- **Mesmo id:** o `preview_id` devolvido é o que você mandou, então qualquer `POST /render` já apontado para ele continua valendo.
- **Idempotente:** reabrir o preview que **já está ativo** não derruba nem respawna a Studio — devolve as URLs atuais com `reused: true` e renova o TTL de 2 horas.
- **Retenção renovada:** reabrir atualiza o `mtime` do diretório, então a contagem das 24h recomeça e uma sessão de edição não é varrida no meio.
- **Não recupera o que já expirou:** se o diretório saiu do disco, a resposta é `404` — aí só resta criar um preview novo com `html`.
- **Não serve para `job_id`:** o diretório de um job de render (`/tmp/hf-jobs/`) não é aceito aqui.

---

## GET /preview

Estado do preview: qual está ativo e o que sobrou em disco.

Existe porque o `DELETE` exige o `preview_id` exato do preview ativo — sem esta rota não havia como descobri-lo. Também mostra quais `preview_id` ainda dão para renderizar.

### Request

**Method:** `GET`  
**Path:** `/preview`

### Response

#### 200 OK

```json
{
  "active": {
    "preview_id": "550e8400-e29b-41d4-a716-446655440000",
    "port": 3031,
    "preview_url": "http://meu-servidor.com:3030/"
  },
  "retention_hours": 24,
  "stored": [
    { "preview_id": "550e8400-...", "age_hours": 0.2, "size_bytes": 4821, "renderable": true },
    { "preview_id": "7c9e6679-...", "age_hours": 6.4, "size_bytes": 91234, "renderable": true }
  ]
}
```

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `active` | `object \| null` | O preview em execução, ou `null` se não há nenhum |
| `active.port` | `integer` | Porta real do studio (pode diferir de `PREVIEW_PORT`) |
| `retention_hours` | `number` | Valor de `PREVIEW_RETENTION_MS` em horas |
| `stored[]` | `array` | Diretórios de preview em disco, do mais novo para o mais velho |
| `stored[].renderable` | `boolean` | Se `POST /render` com esse `preview_id` funciona |

**Um `preview_id` listado em `stored` continua renderizável mesmo que o processo do studio já tenha sido encerrado** — os arquivos sobrevivem à morte do processo. É o que permite renderizar uma edição feita horas antes.

### Exemplo cURL

```bash
# descobrir o preview ativo e encerrá-lo
PID=$(curl -s http://localhost:3030/preview | jq -r '.active.preview_id')
curl -X DELETE "http://localhost:3030/preview/$PID?purge=true"
```

---

## DELETE /preview/:previewId

Encerra o studio e libera a porta. Por padrão **mantém** os arquivos do preview em disco, para que `POST /render` com `preview_id` ainda consiga renderizar as edições salvas na Studio.

### Request

**Method:** `DELETE`  
**Path:** `/preview/:previewId`

#### Path Parameters

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `previewId` | `string` | UUID retornado pelo `POST /preview` |

#### Query Parameters

| Parâmetro | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `purge` | `boolean` | `false` | Se `true`, apaga também os **arquivos** do preview. Por padrão eles são mantidos, para que `POST /render` com `preview_id` ainda consiga renderizar as edições salvas na Studio |

### Response

#### 200 OK

```json
{ "deleted": true, "purged": false }
```

#### 404 Not Found

Retornado quando o `previewId` não corresponde ao preview ativo (ou não há preview ativo).

```json
{ "error": "Preview não encontrado" }
```

### Exemplo cURL

```bash
# Encerra o studio, mantém os arquivos (ainda dá para renderizar por preview_id)
curl -X DELETE http://localhost:3030/preview/550e8400-e29b-41d4-a716-446655440000

# Encerra e apaga tudo
curl -X DELETE "http://localhost:3030/preview/550e8400-e29b-41d4-a716-446655440000?purge=true"
```

---

## Como funciona internamente

```
POST /preview
  ├── resolve a fonte: html (preview novo) ou preview_id (reabrir)
  │     ├── os dois juntos, ou nenhum → 400
  │     ├── preview_id fora do formato UUID → 400 (barra traversal antes de virar path)
  │     └── preview_id sem diretório em disco → 404
  ├── [reabrir] preview_id == o preview JÁ ativo?
  │     └── sim → devolve as URLs atuais, renova o TTL e responde 201 (reused, sem respawn)
  ├── killActivePreview()
  │     ├── SIGTERM no processo anterior (se houver)
  │     ├── arquivos do anterior MANTIDOS (só ?purge=true apaga)
  │     └── executa: hyperframes preview --kill-all  (limpa registry interno)
  ├── [html] salva index.html em /tmp/hf-previews/{previewId}/
  │     ├── salva cada item de compositions (após validar path) em {previewId}/{path}
  │     │     └── path inválido (absoluto ou com "..") → 400 (nenhum studio é spawnado)
  │     └── salva cada asset (via base64 ou fetch(url)) em {previewId}/
  │           └── falha em qualquer asset → rm do dir + 400 (nenhum studio é spawnado)
  ├── [reabrir] nada é escrito; só o mtime do diretório é atualizado (segura a retenção)
  ├── spawnPreview(dir, PREVIEW_PORT)
  │     ├── executa: hyperframes preview --port 3031 --no-open --force-new
  │     ├── aguarda linha "Studio  http://localhost:XXXX" no stdout (timeout: 30s)
  │     └── parseia a porta **real** (pode diferir de PREVIEW_PORT se houver conflito)
  │     └── falha no spawn → 500 (no caminho html o dir é removido; no reabrir, NÃO —
  │           os arquivos são preexistentes e podem ter edições)
  ├── reconstrói preview_url com a porta real e PUBLIC_PREVIEW_URL
  ├── agenda killActivePreview() após PREVIEW_TTL_MS (2h)
  └── responde 201 com preview_url + reused

DELETE /preview/:previewId
  └── killActivePreview() → SIGTERM + --kill-all
        └── arquivos MANTIDOS (a menos de ?purge=true) para permitir
            POST /render { preview_id } com as edições salvas na Studio
```

### Editar e renderizar

```
POST /preview                      → preview_url + preview_id
  ↓
abrir preview_url, editar e SALVAR na Studio
  ↓  (a Studio grava em /tmp/hf-previews/{preview_id}/)
POST /render { "preview_id": ... } → renderiza o que foi salvo
```

Se a Studio já tiver morrido (TTL, DELETE, restart) e você quiser voltar a editar:

```
GET  /preview                       → lista os preview_id ainda em disco
  ↓
POST /preview { "preview_id": ... } → Studio de volta no MESMO id, com as edições
  ↓
editar mais e POST /render { "preview_id": ... }
```

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PUBLIC_BASE_URL` | *(vazio)* | URL pública **desta porta (3030)**. Definida, faz `preview_url` apontar para a Studio proxiada — a única em que salvar edições funciona fora de HTTPS/localhost |
| `PREVIEW_PORT` | `3031` | Porta em que o studio escuta dentro do container |
| `PUBLIC_PREVIEW_URL` | `http://localhost:3031` | URL pública da porta do studio, retornada como `preview_url_direct` |
| `PREVIEW_RETENTION_MS` | `86400000` (24h) | Por quanto tempo os arquivos de um preview sobrevivem depois que o processo morre |
| `STUDIO_PROXY` | `true` | `false` desliga o proxy da Studio nesta porta |
| `PREVIEW_REOPEN` | `true` | `false` desliga a reabertura: `POST /preview` volta a aceitar só `html`, e `preview_id` passa a responder `400` |

**Exemplo para produção no Coolify/VPS:**

```
PUBLIC_BASE_URL=http://meu-vps.com:3030
PREVIEW_PORT=3031
PUBLIC_PREVIEW_URL=http://meu-vps.com:3031
```

---

## Notas

- **1 preview por vez:** qualquer chamada a `POST /preview` encerra o anterior — não há concorrência
- **Porta real pode diferir:** se `PREVIEW_PORT` estiver ocupada, o `hyperframes preview` escolhe outra porta; o servidor parseia a porta real do stdout e reconstrói `preview_url` automaticamente
- **`--kill-all`:** antes de cada preview, o servidor executa `hyperframes preview --kill-all` para limpar studios zumbis que o processo pai não conseguiu encerrar
- **TTL:** o processo é encerrado via SIGTERM após 2 horas; use `DELETE` para encerrar antes
- **Morte inesperada do studio:** se o processo cair sozinho (crash, OOM, kill externo), o servidor detecta a saída, libera o preview ativo e loga um `warn`. As rotas proxiadas voltam a responder `503` na hora, em vez de tentar alcançar uma porta morta. Os arquivos ficam — o `preview_id` segue renderizável
- **Arquivos sobrevivem ao processo:** encerrar o preview (por TTL, por um novo `POST /preview` ou por `DELETE`) **não** apaga os arquivos. Eles ficam por `PREVIEW_RETENTION_MS` (24h), então o `preview_id` continua renderizável — **e reabrível** — mesmo depois do studio morrer, inclusive o de um preview que foi substituído por outro
- **Reabrir é no lugar:** `POST /preview { preview_id }` não copia nada e não gera id novo; a Studio sobe sobre o diretório existente. Uma falha de spawn nesse caminho **não** apaga o diretório, justamente porque ele pode conter edições salvas
- Uso típico: visualizar e **editar** a composição na Studio, e então chamar `POST /render` com o `preview_id` para gerar o MP4 com as edições
