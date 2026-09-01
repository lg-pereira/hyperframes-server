# HyperFrames Server — API Reference

REST API para renderização assíncrona de vídeos com HyperFrames (Chromium + FFmpeg).

## Base URL

```
http://localhost:3030
```

## Autenticação

Nenhuma. A API não requer autenticação.

## Formato

Todas as requisições e respostas usam `application/json`, exceto o endpoint de download que retorna `video/mp4`.

## Endpoints

| Método | Rota | Descrição | Documento |
|--------|------|-----------|-----------|
| `GET` | `/health` | Status do servidor | [health.md](./health.md) |
| `POST` | `/lint` | Valida composição sem renderizar (síncrono) | [lint.md](./lint.md) |
| `POST` | `/check` | Valida composição num browser real: runtime, layout, motion, contraste (síncrono) | [check.md](./check.md) |
| `POST` | `/preview` | Inicia o studio de preview a partir de `html`, ou **reabre** um preview em disco via `preview_id` | [preview.md](./preview.md) |
| `GET` | `/preview` | Estado do preview ativo e dos diretórios retidos | [preview.md](./preview.md) |
| `DELETE` | `/preview/:previewId` | Encerra o preview ativo | [preview.md](./preview.md) |
| `POST` | `/render` | Renderiza uma composição (`html`) ou as edições salvas na Studio (`preview_id`) | [render.md](./render.md) |
| `GET` | `/status/:jobId` | Verifica status de um job | [status.md](./status.md) |
| `GET` | `/download/:jobId` | Baixa o MP4 gerado | [download.md](./download.md) |
| `GET` | `/logs/:jobId` | Log do processo render (diagnóstico) | [logs.md](./logs.md) |
| `POST` | `/mcp` | Servidor MCP: contrato de composição e catálogo de templates para o agente de IA | [mcp.md](./mcp.md) |
| `GET` | `/docs` | Swagger UI interativo | — |

## Fluxos típicos

### Lint (síncrono)

```
POST /lint   → valid: true/false + lista de erros (< 1s)
```

Use para validar a composição antes de qualquer outra chamada.

### Check (validação em browser real)

```
POST /check   → valid: true/false + lista de erros agregada (até ~60s)
```

Roda lint + erros de console/runtime + layout + motion + contraste WCAG AA numa sessão real de Chromium, sem gerar vídeo. Use depois do `/lint` e antes do `/render` para pegar problemas que só aparecem em runtime (layout quebrado, contraste ruim, elementos fora do frame).

### Preview (studio ao vivo, editável)

```
POST /preview   → recebe preview_url + preview_id (201 Created)
```

Abre diretamente no browser. **1 preview ativo por vez** — chamar novamente encerra o anterior.  
Use para visualizar, **editar e salvar** a composição antes de renderizar.

A Studio é servida por esta mesma porta (via proxy), o que permite ao servidor injetar o polyfill de secure context que faz o **save** funcionar em HTTP puro — ver [deploy.md § Edição na Studio](./deploy.md#edição-na-studio-salvar--como-funciona).

### Preview → editar → render

O ciclo completo, sem reenviar HTML:

```
1. POST /preview                       → preview_url + preview_id
         ↓
2. abrir preview_url, editar e SALVAR na Studio
         ↓
3. POST /render {"preview_id": "..."}  → job_id
         ↓
4. GET /status/:job_id → GET /download/:job_id
```

Se a Studio já tiver sido encerrada (TTL de 12h, `DELETE`, restart) e você quiser voltar a editar, `POST /preview {"preview_id": "..."}` **reabre** o mesmo diretório — mesmo id, edições salvas preservadas. `GET /preview` lista os que ainda estão em disco.

### Render (assíncrono)

```
1. POST /render        → recebe job_id (202 Accepted)
         ↓
2. GET  /status/:jobId → polling até status = "done" ou "error"
         ↓
3. GET  /download/:jobId → stream do arquivo MP4
```

### Exemplo completo em bash

```bash
BASE="http://localhost:3030"

# 1. Enviar composição
RESPONSE=$(curl -s -X POST "$BASE/render" \
  -H "Content-Type: application/json" \
  -d '{"html":"<div data-width=\"1920\" data-height=\"1080\"><h1 data-duration=\"3\">Olá!</h1></div>","fps":30}')

JOB_ID=$(echo "$RESPONSE" | jq -r '.job_id')
echo "Job iniciado: $JOB_ID"

# 2. Polling até concluir
while true; do
  STATUS=$(curl -s "$BASE/status/$JOB_ID" | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "done" ] && break
  [ "$STATUS" = "error" ] && exit 1
  sleep 5
done

# 3. Baixar vídeo
curl -o "video-$JOB_ID.mp4" "$BASE/download/$JOB_ID"
echo "Vídeo salvo: video-$JOB_ID.mp4"
```

### Autoria assistida por IA (MCP)

```
POST /mcp   → tools MCP para um agente consultar antes de gerar HTML
```

Expõe o contrato de composição do HyperFrames e o catálogo de 372 templates (transições, efeitos, cenas prontas) como tools MCP, para qualquer cliente MCP (Claude Code, Claude Desktop, Cursor, nós de automação). Ver [mcp.md](./mcp.md).

## Deploy

Para instruções de como subir o servidor em produção (Docker Compose, Coolify, deploy manual), veja [deploy.md](./deploy.md).
