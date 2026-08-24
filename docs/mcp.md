# MCP de autoria (`/mcp`)

Servidor **MCP (Model Context Protocol)** que dá ao agente de IA acesso ao contrato de composição do HyperFrames e ao catálogo de templates — para ele consultar as regras e reaproveitar transições, efeitos e cenas prontas em vez de escrever animação de cabeça.

Feito para o nó **MCP Client Tool** do n8n, mas funciona com qualquer cliente MCP.

**Endpoint:** `POST /mcp` · **Transporte:** Streamable HTTP (stateless) · **Auth:** nenhuma

---

## Por que existe

O MCP nativo da HeyGen não serve a este caso: é um conector hospedado da claude.ai (autenticação via painel), voltado a clientes de chat sem filesystem, e suas ferramentas de autoria (`compose`, `render_video`) são desabilitadas para clientes CLI. Ele opera projetos hospedados no `app.heygen.com`, não HTML local.

Este servidor resolve outro problema: **referência de autoria**. O agente pergunta como se escreve uma composição válida e o que já existe pronto, e então escreve o HTML ele mesmo.

---

## Configurar no n8n

Adicione um nó **MCP Client Tool** conectado ao seu AI Agent:

| Campo | Valor |
|-------|-------|
| `endpointUrl` | `http://<host>:3030/mcp` |
| `serverTransport` | `httpStreamable` (default) |
| `authentication` | `none` |
| `include` | `all` |

A lista de tools carrega sozinha na UI. Se não carregar, veja [Troubleshooting](#troubleshooting).

---

## Tools

### `get_composition_contract`

Sem argumentos. Devolve o contrato de autoria: atributos obrigatórios da raiz (`data-composition-id`, `data-start`, `data-duration`, `data-width`, `data-height`), o marcador `class="clip"`, regras de track, a timeline pausada única em `window.__timelines`, e as regras de determinismo.

**É a tool que o agente deve chamar primeiro.** A descrição dela diz isso explicitamente, para o modelo priorizá-la.

### `get_reference`

| Argumento | Tipo | Descrição |
|-----------|------|-----------|
| `topic` | enum | Documento a buscar |

Tópicos: `data-attributes`, `determinism-rules`, `tracks-and-clips`, `sub-compositions`, `variables-and-media`, `composition-patterns`, `minimal-composition`, `full-screen-motion`, `animation`.

### `search_catalog`

| Argumento | Tipo | Padrão | Descrição |
|-----------|------|--------|-----------|
| `query` | string | — | Busca ranqueada em nome, título, descrição e tags |
| `type` | `block` \| `component` | — | Restringe o tipo |
| `tag` | string | — | Tag exata, ex: `transition` |
| `limit` | integer | `20` | Máximo de resultados (teto 50) |

**154 blocks** (cenas completas e autossuficientes) e **218 components** (snippets e primitivas de movimento). Devolve só metadados.

A busca é **ranqueada, não exigente**: casar parte da consulta já traz resultado, e o que casa mais aparece antes. Tag exata pesa mais que nome, que pesa mais que título, que pesa mais que descrição. Consultas descritivas funcionam (`"cinematic transition"` → `cinematic-zoom` no topo), mas palavras-chave curtas continuam sendo mais precisas — palavras extras diluem o ranking em vez de estreitá-lo. `tag` aceita plural (`transitions` casa `transition`).

Quando nada casa, a resposta inclui `hint` e `available_tags` com as tags mais populares, para o agente tentar de novo com o vocabulário real em vez de desistir do catálogo.

### `list_catalog_tags`

Todas as tags com contagem, para o agente descobrir o que existe. As mais úteis:

`motion-primitive(111)` · `transition(47)` · `overlay(40)` · `typography(40)` · `reveal(26)` · `caption-style(16)` · `lower-third(13)`

### `get_catalog_item`

| Argumento | Tipo | Descrição |
|-----------|------|-----------|
| `name` | string | Nome exato vindo do `search_catalog` |
| `type` | `block` \| `component` | Opcional — resolvido automaticamente |

Devolve dimensões, duração, **`variables[]` tipadas** (cada uma com `id`, `type`, `label`, `description`, `default`) e o **`editing_contract`** — o `TEMPLATE.md` do item, que diz em prosa o que é editável e o que é protegido.

Preencher um template pelas variáveis declaradas é o que mantém a animação intacta. Por isso esta tool vem antes da próxima.

### `get_catalog_item_source`

| Argumento | Tipo | Descrição |
|-----------|------|-----------|
| `name` | string | Nome exato do item |
| `type` | `block` \| `component` | Opcional |
| `path` | string | Arquivo específico; default é o HTML principal |

O código real. Arquivos grandes são truncados em 40KB (`MCP_MAX_SOURCE_BYTES`) com marcador explícito e o tamanho real em bytes.

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `MCP_ENABLED` | `true` | `false` remove as rotas `/mcp` — rollback sem deploy |
| `MCP_CACHE_DIR` | `/tmp/hf-mcp-cache` | Onde o catálogo e os docs são cacheados |
| `MCP_CACHE_TTL_MS` | `86400000` (24h) | Validade do cache dos documentos |
| `MCP_MAX_SOURCE_BYTES` | `40000` | Teto do retorno de `get_catalog_item_source` |

---

## Como o cache funciona

Todo o conteúdo vem do repo `heygen-com/hyperframes` no GitHub. O pacote npm **não** traz os docs de contrato — `dist/docs` tem ~7.8KB de conteúdo fino e `dist/skills` só inclui `hyperframes` e `hyperframes-cli`. Os documentos bons vivem em `skills/` no repositório.

**Catálogo.** O `registry.json` é apenas um índice: `name` e `type` (prefixado, `hyperframes:block`). Tags, título e descrição vivem no `registry-item.json` de cada item, então montar um catálogo pesquisável exige hidratar os 372 itens — é o que o próprio `hyperframes catalog` faz. O resultado agregado é cacheado num único arquivo **chaveado pela `catalogArtifact.revision` do upstream**: quando a HeyGen publica itens novos, a revisão muda e o cache invalida sozinho, sem TTL adivinhado.

Cache frio: ~6s. Quente: ~20ms.

**Degrau `stale-while-error`.** A ordem é cache fresco → rede → cache velho. O último degrau é o que importa em produção: se o GitHub cair, o agente recebe conteúdo levemente velho com um aviso no payload (`_warning`), em vez de um erro que travaria a geração da cena. Só falha de verdade quando não há cache **nem** rede.

**Warm-up no build.** `scripts/warm-mcp-cache.mjs` roda no `Dockerfile` e pré-carrega tudo (~1.6s), para a primeira chamada em produção já ser rápida. Ele **nunca falha o build**: uma imagem construída sem rede ainda gera um container funcional, porque o runtime busca sob demanda.

---

## Testar com curl

O transporte exige `Accept` com os dois tipos:

```bash
MCP=http://localhost:3030/mcp
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')

# handshake
curl -s -X POST $MCP "${H[@]}" -d '{
  "jsonrpc":"2.0","id":1,"method":"initialize",
  "params":{"protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name":"curl","version":"1"}}}'

# listar as tools
curl -s -X POST $MCP "${H[@]}" -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# buscar transições
curl -s -X POST $MCP "${H[@]}" -d '{
  "jsonrpc":"2.0","id":3,"method":"tools/call",
  "params":{"name":"search_catalog","arguments":{"tag":"transition","limit":5}}}'
```

As respostas vêm como SSE (`event: message` / `data: {...}`), mesmo em chamadas simples — é o formato do Streamable HTTP.

---

## Troubleshooting

**As tools não carregam no n8n.** Confirme `serverTransport=httpStreamable` (não `sse`) e que a URL termina em `/mcp`. Teste o `initialize` por curl a partir da mesma rede do n8n.

**`404` em `/mcp`.** `MCP_ENABLED=false` no ambiente.

**Primeira chamada lenta (~6s).** Cache frio hidratando os 372 itens. Não deveria acontecer em produção — o build aquece. Se acontecer, o volume `hf_mcp_cache` provavelmente foi recriado vazio.

**Respostas com `_warning`.** O GitHub estava inacessível e o conteúdo veio do cache velho. É o comportamento pretendido; verifique a saída de rede do container.

---

## Notas

- **Sem autenticação**, igual ao resto da API (rede Tailscale). O MCP Client Tool do n8n suporta `bearerAuth`/`headerAuth` se vocês quiserem fechar depois — é trocar a opção no nó e adicionar a checagem em [mcp/index.mjs](../mcp/index.mjs).
- **Stateless:** cada requisição cria e descarta seu próprio `McpServer` e transport. Não há sessão para expirar nem estado entre chamadas.
- **Sem validação de composição** por ora. É a adição mais óbvia depois — o `POST /lint` e o `POST /check` já existem e permitiriam ao agente se autocorrigir antes de renderizar.
