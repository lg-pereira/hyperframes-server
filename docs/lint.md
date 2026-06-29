# POST /lint

Valida uma composição HyperFrames sem renderizar. **Síncrono** — retorna direto na resposta em menos de 1 segundo.

Use antes de chamar `/preview` ou `/render` para capturar erros de estrutura do HTML antecipadamente.

## Request

**Method:** `POST`  
**Path:** `/lint`  
**Content-Type:** `application/json`

### Body

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `html` | `string` | Sim | Conteúdo do `index.html` da composição HyperFrames |

```json
{
  "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>"
}
```

## Response

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
      "rule": "missing-duration",
      "message": "Element <h1> is missing required attribute data-duration",
      "element": "h1"
    },
    {
      "rule": "invalid-dimension",
      "message": "data-width must be a positive integer",
      "element": "div"
    }
  ],
  "error_count": 2
}
```

### Campos da resposta

| Campo | Tipo | Descrição |
|-------|------|-----------|
| `valid` | `boolean` | `true` se nenhum erro encontrado |
| `errors` | `array` | Lista de erros (vazia se válido) |
| `errors[].rule` | `string` | Identificador da regra violada |
| `errors[].message` | `string` | Descrição legível do erro |
| `errors[].element` | `string` | Elemento HTML onde o erro ocorre (pode ser vazio) |
| `error_count` | `integer` | Total de erros encontrados |

## Como funciona

O `/lint` é **síncrono**: bloqueia até o processo terminar e devolve o resultado direto na resposta — diferente do `/render`, que retorna imediatamente com um `job_id`.

Internamente executa:

```
hyperframes lint <dir> --json
```

O HTML é salvo em um diretório temporário e o lint recebe o **diretório** (não o arquivo). Tem dois modos de operação dependendo da versão do HyperFrames instalada:

| Modo | Quando | Comportamento |
|------|--------|---------------|
| **JSON** | Versão suporta `--json` | Retorna erros estruturados com `rule`, `message` e `element` |
| **Fallback de texto** | Versão não suporta `--json` | Servidor parseia a saída em texto e normaliza para o mesmo formato |

O formato da resposta é sempre o mesmo independente do modo — você nunca recebe um erro 500 por incompatibilidade de versão.

## Exemplos cURL

### Verificação simples

```bash
curl -s -X POST http://localhost:3030/lint \
  -H "Content-Type: application/json" \
  -d '{
    "html": "<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>"
  }' | jq .
```

### Verificar apenas se é válido (bash)

```bash
VALID=$(curl -s -X POST http://localhost:3030/lint \
  -H "Content-Type: application/json" \
  -d '{"html":"<seu html aqui>"}' \
  | jq -r '.valid')

if [ "$VALID" = "true" ]; then
  echo "Composição válida, prosseguindo..."
else
  echo "Erros encontrados, abortando."
  exit 1
fi
```

### Fluxo lint → render

```bash
BASE="http://localhost:3030"
HTML='<div data-width="1920" data-height="1080"><h1 data-duration="3">Teste</h1></div>'

# 1. Lint antes de renderizar
LINT=$(curl -s -X POST "$BASE/lint" \
  -H "Content-Type: application/json" \
  -d "{\"html\": $(echo "$HTML" | jq -Rs .)}")

if [ "$(echo "$LINT" | jq -r '.valid')" != "true" ]; then
  echo "Lint falhou:"
  echo "$LINT" | jq '.errors'
  exit 1
fi

# 2. Render
JOB_ID=$(curl -s -X POST "$BASE/render" \
  -H "Content-Type: application/json" \
  -d "{\"html\": $(echo "$HTML" | jq -Rs .)}" \
  | jq -r '.job_id')

echo "Render iniciado: $JOB_ID"
```

## Notas

- Timeout interno de **15 segundos**
- Os arquivos temporários criados durante o lint são **sempre removidos** ao final, mesmo em caso de erro
- Não valida assets (imagens, áudio) — apenas a estrutura do HTML
- Use no início do pipeline, antes de `/preview` ou `/render`, para economizar tempo
