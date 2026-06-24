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
