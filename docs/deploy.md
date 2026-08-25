# Deploy Guide

Como subir o HyperFrames Server em produção.

## Pré-requisitos

O servidor requer Chromium e FFmpeg. Ambos estão incluídos no `Dockerfile` — não é necessário instalá-los manualmente ao usar Docker.

**Portas expostas:** `3030` (API + Studio, é por onde salvar edições funciona) e `3031` (studio do hyperframes, acesso direto/diagnóstico — ver [seção abaixo](#edição-na-studio-salvar--como-funciona))  
**Variáveis de ambiente obrigatórias:** nenhuma

## Docker Compose (recomendado)

O projeto inclui um `docker-compose.yaml` pronto para uso.

### Subir o servidor

```bash
docker compose up -d
```

### Parar o servidor

```bash
docker compose down
```

### Ver logs em tempo real

```bash
docker compose logs -f hyperframes-server
```

### Rebuild após mudanças no código

```bash
docker compose up -d --build
```

### Configuração do docker-compose.yaml

| Configuração | Valor | Motivo |
|-------------|-------|--------|
| `shm_size: 4gb` | Memória compartilhada | Obrigatório para o Chromium não crashar em composições grandes. Com poucos workers de render, 2 GB costumam bastar |
| `init: true` | Habilita init process | Evita processos zumbi do Chromium (PID 1) |
| `restart: unless-stopped` | Reinicia automaticamente | Recuperação de crashes sem intervenção manual |
| `volumes: hf_jobs` | Volume persistente | Jobs em andamento sobrevivem a restarts do container |
| `volumes: hf_previews` | Volume persistente | Previews retidos (24h) sobrevivem a restarts — é o que mantém `preview_id` renderizável e reabrível |
| `volumes: hf_mcp_cache` | Volume persistente | Cache do MCP de autoria, aquecido no build; evita a primeira chamada lenta |
| `healthcheck` | `GET /health` a cada 30s | Monitoramento automático pelo Docker |

### Variáveis de ambiente configuradas automaticamente

| Variável | Valor | Descrição |
|----------|-------|-----------|
| `NODE_ENV` | `production` | Modo de produção do Node.js |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` | Evita baixar Chromium do npm (já instalado no sistema) |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Aponta para o Chromium do sistema |
| `HYPERFRAMES_PREVIEW_HOST` | `0.0.0.0` | A Studio faz bind em `127.0.0.1` por padrão, o que a torna inalcançável pelo port-mapping do Docker |

### Todas as variáveis de ambiente

Nenhuma é obrigatória — o servidor sobe com os padrões. Esta é a referência completa; cada uma é detalhada no documento do endpoint correspondente.

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PUBLIC_BASE_URL` | *(vazio)* | URL pública da porta 3030. Definida, faz `preview_url` apontar para a Studio proxiada, com o polyfill que permite salvar em HTTP puro |
| `PUBLIC_PREVIEW_URL` | `http://localhost:3031` | URL pública da porta do studio, devolvida em `preview_url_direct` |
| `PREVIEW_PORT` | `3031` | Porta em que o studio escuta |
| `STUDIO_PROXY` | `true` | `false` desliga o proxy da Studio nesta porta |
| `PREVIEW_REOPEN` | `true` | `false` desliga `POST /preview {preview_id}` (reabrir um preview em disco) |
| `PREVIEW_RETENTION_MS` | `86400000` (24h) | Por quanto tempo os arquivos de um preview sobrevivem ao processo da Studio |
| `RENDER_WORKERS` | `auto` (`4` no compose) | Workers paralelos por render. Ajuste conforme cores e RAM |
| `MCP_ENABLED` | `true` | `false` remove as rotas `/mcp` |
| `MCP_CACHE_DIR` | `/tmp/hf-mcp-cache` | Onde o catálogo e os docs do MCP são cacheados |
| `MCP_CACHE_TTL_MS` | `86400000` (24h) | Validade do cache de documentos do MCP |
| `MCP_MAX_SOURCE_BYTES` | `40000` | Teto do retorno de `get_catalog_item_source` |

Os quatro kill-switches (`STUDIO_PROXY`, `PREVIEW_REOPEN`, `MCP_ENABLED` e a ausência de `PUBLIC_BASE_URL`) existem para rollback **sem deploy de código**: basta mudar a variável e reiniciar.

## Coolify

O servidor pode ser deployado diretamente pelo Dockerfile do repositório.

### Passos

1. No painel do Coolify, crie um novo **Resource → Dockerfile**
2. Aponte para o repositório Git do projeto
3. Defina a porta: `3030` — ela serve a API **e** a Studio. Não é preciso expor a `3031` publicamente
4. Em **Environment Variables**, adicione:
   ```
   NODE_ENV=production
   PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
   PUBLIC_BASE_URL=http://<seu-host>:3030
   ```
   `PUBLIC_BASE_URL` é o que faz a Studio ser entregue pela 3030 com o polyfill — ver [Edição na Studio](#edição-na-studio-salvar--como-funciona).
5. Em **Advanced**, configure memória compartilhada (`/dev/shm`) para ao menos **2 GB** — isso é crítico para o Chromium funcionar corretamente
6. Ative o health check apontando para `http://<host>:3030/health`
7. Clique em **Deploy**

### Health check para Coolify

```
http://<host>:3030/health
```

Resposta esperada: `{"status":"ok","uptime":<number>}`

## Edição na Studio (salvar) — como funciona

A Studio é o preview embutido do hyperframes, exposto via `POST /preview`. Editar e **salvar** ali exige um detalhe de navegador que vale entender.

### O problema

O bundle da Studio (`node_modules/hyperframes/dist/studio/index.js`) usa duas APIs **sem fallback**:

- `globalThis.crypto.randomUUID()` em `createStudioWriteToken()` — gera o header `X-Hyperframes-Write-Token` de **toda** mutação (save de HTML, edição animada, corte/split).
- `globalThis.crypto.subtle.digest("SHA-256", ...)` em `studioFileContentVersion()` — checagem de concorrência otimista antes de cada save.

Ambas são *secure-context only*: o navegador só as expõe em **HTTPS ou `localhost`**. Servindo em `http://<IP>:<porta>`, as duas ficam `undefined` e todo save quebra com erros como:

- `Couldn't save "Scene5 Stat Num": globalThis.crypto.randomUUID is not a function`
- `Cannot read properties of undefined (reading 'digest')`
- `Couldn't save index.html / index2.html — your latest edits are NOT persisted...`
- `Failed to save animated edit.`

### A solução: a Studio é servida pela porta 3030

O servidor **proxia a Studio pela porta da API (3030)** e injeta [`studio-polyfill.js`](../studio-polyfill.js) no `<head>` do HTML dela, antes do bundle. O polyfill reimplementa `crypto.randomUUID` (UUID v4 sobre `crypto.getRandomValues`, que **não** é secure-context gated), `crypto.subtle.digest("SHA-256")` (em JS puro) e `navigator.clipboard.writeText`.

Resultado: **salvar funciona em HTTP puro, sem nenhuma configuração de TLS.** Em HTTPS ou `localhost` o polyfill detecta as APIs nativas e vira no-op completo.

O SHA-256 do polyfill é verificado contra `node:crypto` em `npm test` — se ele divergisse, a Studio calcularia uma versão de arquivo que não bate com a do servidor e todo save morreria em `409 conflict`.

### Configuração

Defina `PUBLIC_BASE_URL` com a URL pública **da porta 3030**:

```
PUBLIC_BASE_URL=http://<seu-host>:3030
```

A partir daí, `POST /preview` devolve `preview_url` já apontando para a Studio proxiada (com polyfill). O campo `preview_url_direct` continua trazendo a URL da 3031, para diagnóstico.

**Enquanto `PUBLIC_BASE_URL` não estiver definida, nada muda:** `preview_url` continua sendo a URL da 3031 e o comportamento é idêntico ao de antes. A migração é opt-in, e o rollback é remover a variável.

### Rollout recomendado

1. Suba a versão nova **sem** `PUBLIC_BASE_URL`. O fluxo atual segue intacto; a Studio proxiada fica disponível em paralelo em `http://<host>:3030/` para você testar.
2. Abra `http://<host>:3030/`, edite um elemento e confirme que o save funciona.
3. Só então defina `PUBLIC_BASE_URL` e faça o redeploy, para que o `preview_url` migre.

### Variáveis relacionadas

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PUBLIC_BASE_URL` | *(vazio)* | URL pública da porta 3030. Definida, faz `preview_url` apontar para a Studio proxiada (com polyfill) |
| `STUDIO_PROXY` | `true` | `false` desliga o proxy e remove as rotas da Studio desta porta — rollback sem deploy de código |
| `PREVIEW_RETENTION_MS` | `86400000` (24h) | Por quanto tempo os arquivos de um preview sobrevivem, para que `POST /render {preview_id}` possa renderizar as edições salvas |
| `PREVIEW_REOPEN` | `true` | `false` desliga `POST /preview {preview_id}` (reabrir a Studio sobre um preview em disco) — rollback sem deploy de código |

### E a porta 3031?

Continua exposta e servindo o preview como sempre, **mas sem o polyfill** — salvar por ela em HTTP puro continua quebrando. Ela é útil para diagnóstico. Se um dia você parar de expor a 3031, troque `HYPERFRAMES_PREVIEW_HOST` de `0.0.0.0` para `127.0.0.1` no `docker-compose.yaml`.

### HTTPS ainda vale a pena?

Sim — deixa de ser **obrigatório**, mas continua sendo o ideal (o polyfill some do caminho e você ganha as APIs nativas do navegador). Se quiser configurar, no Coolify: adicione um domínio apontando para a porta **3030** do container, habilite Let's Encrypt, e defina `PUBLIC_BASE_URL=https://<seu-domínio>`. Não é preciso expor a 3031 publicamente.

### Verificação

1. Abrir a Studio pela URL de `preview_url`, editar um elemento e confirmar que o save funciona.
2. No console do navegador: `crypto.randomUUID` e `crypto.subtle` devem estar **definidos** mesmo com `window.isSecureContext === false`.
3. Nos logs, `POST /preview` avisa se a Studio estiver sendo entregue sem o proxy (ou seja, sem polyfill).

## Deploy manual (sem Docker)

Se preferir rodar sem container:

### Pré-requisitos do sistema

```bash
# Debian/Ubuntu
apt-get install -y chromium ffmpeg nodejs npm

# Node.js 22+
node --version  # v22.x.x
```

### Instalar e iniciar

```bash
cd hyperframes-server
npm install
NODE_ENV=production \
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
PUPPETEER_EXECUTABLE_PATH=$(which chromium) \
node server.mjs
```

### Com PM2 (recomendado para produção sem Docker)

```bash
npm install -g pm2

pm2 start server.mjs --name hyperframes-server \
  --env production \
  -- \
  PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=$(which chromium)

pm2 save
pm2 startup
```

## Verificar que o servidor está rodando

```bash
curl http://localhost:3030/health
# {"status":"ok","uptime":12.34}
```

## Notas de produção

- **Sem autenticação.** Nenhuma rota exige credencial — a API pressupõe rede confiável (rede interna, VPN ou um reverse proxy que faça a autenticação). Não exponha as portas 3030/3031 na internet aberta: `POST /render` e `POST /preview` executam Chromium e escrevem em disco, e `assets[].url` faz o servidor buscar URLs arbitrárias.
- **Armazenamento temporário:** jobs ficam em `/tmp/hf-jobs/` e são deletados 60s após o download. Previews ficam em `/tmp/hf-previews/` e são varridos após `PREVIEW_RETENTION_MS` (24h). Nenhum dos dois serve como armazenamento permanente.
- **Concorrência:** múltiplos jobs rodam em paralelo, cada um como processo separado. Monitore uso de CPU e memória com composições pesadas.
- **Timeout:** cada job tem timeout de 10 minutos — composições muito longas ou complexas podem falhar.
- **Logs:** o servidor usa Pino com pretty-print. Em produção, redirecione stdout para um agregador de logs.
