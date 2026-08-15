# Deploy Guide

Como subir o HyperFrames Server em produção.

## Pré-requisitos

O servidor requer Chromium e FFmpeg. Ambos estão incluídos no `Dockerfile` — não é necessário instalá-los manualmente ao usar Docker.

**Porta exposta:** `3030`  
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
| `shm_size: 2gb` | 2 GB de memória compartilhada | Obrigatório para o Chromium não crashar em composições grandes |
| `init: true` | Habilita init process | Evita processos zumbi do Chromium (PID 1) |
| `restart: unless-stopped` | Reinicia automaticamente | Recuperação de crashes sem intervenção manual |
| `volumes: hf_jobs` | Volume persistente | Jobs em andamento sobrevivem a restarts do container |
| `healthcheck` | `GET /health` a cada 30s | Monitoramento automático pelo Docker |

### Variáveis de ambiente configuradas automaticamente

| Variável | Valor | Descrição |
|----------|-------|-----------|
| `NODE_ENV` | `production` | Modo de produção do Node.js |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` | Evita baixar Chromium do npm (já instalado no sistema) |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Aponta para o Chromium do sistema |

## Coolify

O servidor pode ser deployado diretamente pelo Dockerfile do repositório.

### Passos

1. No painel do Coolify, crie um novo **Resource → Dockerfile**
2. Aponte para o repositório Git do projeto
3. Defina a porta: `3030`
4. Em **Environment Variables**, adicione:
   ```
   NODE_ENV=production
   PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
   ```
5. Em **Advanced**, configure memória compartilhada (`/dev/shm`) para ao menos **2 GB** — isso é crítico para o Chromium funcionar corretamente
6. Ative o health check apontando para `http://<host>:3030/health`
7. Clique em **Deploy**

### Health check para Coolify

```
http://<host>:3030/health
```

Resposta esperada: `{"status":"ok","uptime":<number>}`

## HTTPS obrigatório para edição na Studio

A porta `3031` serve a Studio (preview embutido do hyperframes, exposto via `POST /preview`). Se ela for acessada em HTTP puro (fora de `localhost`), a edição de vídeos quebra com erros como:

- `Couldn't save index.html / index2.html — your latest edits are NOT persisted...`
- `Failed to save animated edit.`
- `Cannot read properties of undefined (reading 'digest')`
- `Couldn't save "Scene5 Stat Num": globalThis.crypto.randomUUID is not a function`

### Causa raiz

O bundle da Studio (`node_modules/hyperframes/dist/studio/index.js`) usa `globalThis.crypto.randomUUID()` (em `createStudioWriteToken()`, usado em todo save/mutação) e `globalThis.crypto.subtle.digest("SHA-256", ...)` (em `studioFileContentVersion()`, usado na checagem de concorrência otimista) sem fallback. Essas APIs só existem no navegador em **secure context** (HTTPS ou `localhost`) — fora disso, ficam `undefined` e todo save falha.

Não dá para corrigir isso só editando este repo — o bundle não expõe fallback para esses call sites. **A correção é servir a porta 3031 via HTTPS.**

### Passo a passo no Coolify

1. No painel do Coolify, na mesma aplicação do `hyperframes-server`, adicione um novo domínio apontando para a porta **3031** do container (análogo ao domínio/porta já configurado para a `3030`).
2. Configure o DNS do domínio escolhido (A/AAAA ou CNAME) para o IP do VPS, se ainda não estiver apontado.
3. No Coolify, habilite **Let's Encrypt / HTTPS automático** para esse domínio — o Coolify provisiona e renova o certificado sozinho via Traefik.
4. Confirme que o Traefik está roteando `https://<domínio>` → porta interna `3031` do container (sem exigir porta na URL pública; o TLS termina em 443).
5. Atualize a variável de ambiente `PUBLIC_PREVIEW_URL` no Coolify para o domínio HTTPS definitivo, por exemplo:
   ```
   PUBLIC_PREVIEW_URL=https://hf.consultorluizg.com.br
   ```
6. Faça o redeploy do serviço para a env var entrar em vigor.

### Verificação

1. Abrir a Studio pela URL retornada por `POST /preview`, editar um elemento e confirmar que o save funciona.
2. No console do navegador, confirmar que `window.crypto.randomUUID` e `window.crypto.subtle` estão definidos.
3. Se `PUBLIC_PREVIEW_URL` ainda estiver em HTTP fora de `localhost`, o servidor loga um `warn` em cada `POST /preview` avisando da causa raiz — útil para diagnosticar sem precisar reproduzir o erro no navegador.

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

- **Armazenamento temporário:** jobs ficam em `/tmp/hf-jobs/` e são deletados 60s após o download. Não use para armazenamento permanente.
- **Concorrência:** múltiplos jobs rodam em paralelo, cada um como processo separado. Monitore uso de CPU e memória com composições pesadas.
- **Timeout:** cada job tem timeout de 10 minutos — composições muito longas ou complexas podem falhar.
- **Logs:** o servidor usa Pino com pretty-print. Em produção, redirecione stdout para um agregador de logs.
