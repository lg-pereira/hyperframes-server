# ── Base: Debian-slim para compatibilidade total com Chromium/glibc ──────────
FROM node:22-slim

# ── Dependências de sistema para Chromium + FFmpeg ───────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto \
    fonts-noto-color-emoji \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# ── Variáveis do Puppeteer: usa o Chromium do sistema, não baixa outro ────────
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# ── Diretório de trabalho ─────────────────────────────────────────────────────
WORKDIR /app

# ── Instala dependências Node (cache de camada separada do código-fonte) ──────
COPY package*.json ./
RUN npm ci --omit=dev

# ── Copia o servidor ──────────────────────────────────────────────────────────
# studio-polyfill.js é lido no boot e injetado no HTML da Studio servida pelo
# proxy — sem ele, salvar edições quebra fora de HTTPS/localhost.
# preview-source.mjs é importado por server.mjs no topo: sem ele o processo nem
# inicia (ERR_MODULE_NOT_FOUND) e o container fica em restart loop.
COPY server.mjs preview-source.mjs studio-polyfill.js ./
COPY mcp ./mcp
COPY scripts ./scripts

# ── Pré-aquece o cache do MCP ────────────────────────────────────────────────
# Sem isso a primeira chamada do agente paga ~6s hidratando o catálogo. O script
# sempre sai com 0: build sem rede não pode quebrar a imagem (o runtime busca sob
# demanda, e o degrau stale-while-error cobre o GitHub fora do ar).
ENV MCP_CACHE_DIR=/opt/hf-mcp-cache
RUN mkdir -p /opt/hf-mcp-cache && node scripts/warm-mcp-cache.mjs

# ── Usuário sem privilégios para rodar o Chromium com segurança ───────────────
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads /tmp/hf-jobs /tmp/hf-previews \
    && chown -R pptruser:pptruser /home/pptruser /tmp/hf-jobs /tmp/hf-previews /app /opt/hf-mcp-cache

USER pptruser

# API + Studio (a Studio é servida por esta porta, com o polyfill de secure
# context injetado — é por aqui que salvar edições funciona).
EXPOSE 3030
# Porta do studio do hyperframes. Continua exposta para acesso direto/diagnóstico,
# mas sem o polyfill: salvar por ela só funciona em HTTPS ou localhost.
EXPOSE 3031

# ── init=true no Compose resolve o PID 1 / processos zumbi do Chromium ───────
CMD ["node", "server.mjs"]