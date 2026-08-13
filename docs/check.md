# POST /check

Valida uma composição HyperFrames rodando de fato num browser (Chromium) — lint + erros de console/runtime + layout (overflow/clipping/overlap) + assertions de `*.motion.json` + contraste WCAG AA, tudo numa única sessão. **Síncrono** — pode levar até ~60 segundos, mas não gera vídeo (sem encoding).

Use entre `/lint` (mais rápido, mas só olha a estrutura do HTML) e `/render` (gera o vídeo de fato). Se o `hyperframes check` acusar erro de lint, ele já para por aí e nem chega a abrir o browser.

## Request

**Method:** `POST`
**Path:** `/check`
**Content-Type:** `application/json`

### Body

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `html` | `string` | Sim | Conteúdo do `index.html` da composição HyperFrames |
| `assets` | `array` | Não | Arquivos adicionais (áudio, imagens). Cada item aceita `base64` OU `url`. Necessário para o check avaliar layout/contraste de verdade — diferente do `/lint`, que não precisa deles |
| `strict` | `boolean` | Não | Se `true`, também falha (`valid: false`) em warnings, não só erros. Padrão: `false` |
| `samples` | `integer` | Não | Nº de amostras no tempo da composição. Padrão do CLI: `9` |
| `at` | `array<number>` | Não | Timestamps explícitos em segundos para amostrar, em vez da grade automática. Ex: `[0, 1.5, 3]` |
| `tolerance` | `number` | Não | Overflow em pixels tolerado antes de reportar. Padrão do CLI: `2` |
| `contrast` | `boolean` | Não | Se `false`, pula o passe de contraste WCAG AA. Padrão: `true` |

```json
{
  "html": "<div data-composition-id=\"root\" data-width=\"1920\" data-height=\"1080\" data-start=\"0\" data-duration=\"3\"><h1 class=\"clip\" data-start=\"0\" data-duration=\"3\">Olá!</h1></div>"
}
```

## Response

A resposta usa **o mesmo formato do `/lint`** — `{ valid, errors, error_count }` — para que qualquer client que já trate `/lint` funcione sem alteração ao chamar `/check`.

### 200 OK — Composição válida

```json
{
  "valid": true,
  "errors": [],
  "error_count": 0
}
```

### 200 OK — Composição com erros

```json
{
  "valid": false,
  "errors": [
    {
      "rule": "root_missing_composition_id",
      "message": "Root composition is missing `data-composition-id`.",
      "element": "[data-composition-id]"
    },
    {
      "rule": "timed_element_missing_clip_class",
      "message": "<h1> has timing attributes but no class=\"clip\". The element will be visible for the entire composition instead of only during its scheduled time range.",
      "element": "[data-composition-id]"
    }
  ],
  "error_count": 2
}
```

### Campos da resposta

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `valid` | `boolean` | `true` se nenhum erro encontrado (`ok: true` no `hyperframes check`) |
| `errors` | `array` | Lista de achados agregados das 5 categorias do check (lint, runtime, layout, motion, contrast) |
| `errors[].rule` | `string` | Código da regra/achado violado |
| `errors[].message` | `string` | Descrição legível do erro |
| `errors[].element` | `string` | Seletor do elemento HTML onde o erro ocorre (pode ser vazio) |
| `error_count` | `integer` | Total de erros encontrados |

### 400 Bad Request — Asset inválido

```json
{ "error": "Asset \"narration.mp3\" precisa de \"base64\" ou \"url\"" }
```

### 500 Internal Server Error — Timeout ou falha do próprio check

```json
{ "error": "hyperframes check excedeu o tempo limite (60s)" }
```

## Como funciona

Internamente executa:

```
hyperframes check <dir> --json [--strict] [--samples N] [--at t1,t2,...] [--tolerance N] [--no-contrast]
```

O HTML e os assets são salvos num diretório temporário sob `/tmp/hf-jobs`, sempre removido ao final (sucesso ou erro). O `hyperframes check` entrega um JSON com achados separados em 5 categorias (`lint`, `runtime`, `layout`, `motion`, `contrast`); o servidor achata tudo num único array e normaliza para o mesmo formato `{ rule, message, element }` do `/lint`.

Assim como o `/lint`, exit code não-zero por achados do check **não é erro HTTP** — é resultado de negócio normal, respondido como `200` com `valid: false`. Só timeout (60s) ou falha de execução do processo em si vira `500`.

## Exemplos cURL

### Verificação simples

```bash
curl -s -X POST http://localhost:3030/check \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-composition-id=\"root\" data-width=\"1920\" data-height=\"1080\" data-start=\"0\" data-duration=\"3\"><h1 class=\"clip\" data-start=\"0\" data-duration=\"3\">Olá!</h1></div>"
  }' | jq .
```

### Fluxo lint → check → render

```bash
BASE="http://localhost:3030"
HTML='<div data-composition-id="root" data-width="1920" data-height="1080" data-start="0" data-duration="3"><h1 class="clip" data-start="0" data-duration="3">Teste</h1></div>'

# 1. Lint rápido antes de tudo
LINT=$(curl -s -X POST "$BASE/lint" \
  -H "Content-Type: application/json" \
  -d "{\"html\": $(echo "$HTML" | jq -Rs .)}")

if [ "$(echo "$LINT" | jq -r '.valid')" != "true" ]; then
  echo "Lint falhou:"; echo "$LINT" | jq '.errors'; exit 1
fi

# 2. Check completo (browser real) antes de gastar tempo com render
CHECK=$(curl -s -X POST "$BASE/check" \
  -H "Content-Type: application/json" \
  -d "{\"html\": $(echo "$HTML" | jq -Rs .)}")

if [ "$(echo "$CHECK" | jq -r '.valid')" != "true" ]; then
  echo "Check falhou:"; echo "$CHECK" | jq '.errors'; exit 1
fi

# 3. Render
JOB_ID=$(curl -s -X POST "$BASE/render" \
  -H "Content-Type: application/json" \
  -d "{\"html\": $(echo "$HTML" | jq -Rs .)}" \
  | jq -r '.job_id')

echo "Render iniciado: $JOB_ID"
```

## Notas

- Timeout interno de **60 segundos** (contra 15s do `/lint`, já que o `check` abre um browser real)
- Os arquivos temporários criados durante o check são **sempre removidos** ao final, mesmo em caso de erro
- Diferente do `/lint`, o `/check` aceita `assets` — necessários para avaliar layout e contraste com mídia real presente
- Se o lint interno do `check` falhar, o browser nem chega a abrir — a resposta ainda vem no mesmo formato, só que só com achados de lint
