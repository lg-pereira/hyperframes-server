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
COPY server.mjs .

# ── Usuário sem privilégios para rodar o Chromium com segurança ───────────────
RUN groupadd -r pptruser && useradd -r -g pptruser -G audio,video pptruser \
    && mkdir -p /home/pptruser/Downloads /tmp/hf-jobs /tmp/hf-previews \
    && chown -R pptruser:pptruser /home/pptruser /tmp/hf-jobs /tmp/hf-previews /app

USER pptruser

EXPOSE 3030

# ── init=true no Compose resolve o PID 1 / processos zumbi do Chromium ───────
CMD ["node", "server.mjs"]