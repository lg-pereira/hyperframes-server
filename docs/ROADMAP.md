# Roadmap

Duas features candidatas para implementação futura. Cada seção documenta causa raiz / motivação, desenho proposto e passos de implementação com referências de arquivo, para que qualquer pessoa (ou uma sessão futura do Claude) possa pegar e executar sem precisar reinvestigar do zero.

---

## 1. HTTPS obrigatório para edição na Studio — ✅ código concluído, ⏳ infra pendente

### Status

Código e docs implementados (ver commits/diff em `docker-compose.yaml`, `server.mjs`, `docs/deploy.md`). Falta apenas o passo 1 (Coolify), que só pode ser executado por quem tem acesso ao painel. Domínio definido: `hf.consultorluizg.com.br`. Ver checklist em [docs/deploy.md § HTTPS obrigatório para edição na Studio](deploy.md#https-obrigatório-para-edição-na-studio).

### Motivação

Usuários reportam estes erros ao editar vídeos na Studio (preview embutido, servido por `hyperframes preview` via `POST /preview`):

- `Couldn't save index.html / index2.html — your latest edits are NOT persisted...`
- `Failed to save animated edit.`
- `Cannot read properties of undefined (reading 'digest')`
- `Couldn't save "Scene5 Stat Num": globalThis.crypto.randomUUID is not a function`

### Causa raiz (confirmada por leitura de código)

- `node_modules/hyperframes/dist/studio/index.js` usa `globalThis.crypto.randomUUID()` sem fallback em `createStudioWriteToken()` (~linha 12028) para gerar o token de escrita enviado em **todo** save/mutação (13 call sites: save de HTML, edição animada, corte/split).
- Também usa `globalThis.crypto.subtle.digest("SHA-256", ...)` sem guarda em `studioFileContentVersion()` (~linha 54166), usado para checagem de concorrência otimista antes de salvar.
- `crypto.randomUUID` e `crypto.subtle` só existem no navegador em **contexto seguro** (HTTPS ou `localhost`). Fora disso, ambos são `undefined`.
- O deploy atual serve a Studio em **HTTP puro**: até a correção abaixo, [docker-compose.yaml:29](../docker-compose.yaml#L29) definia `PUBLIC_PREVIEW_URL=${PUBLIC_PREVIEW_URL:-http://100.121.2.102:3031}`; [server.mjs:29](../server.mjs#L29) também cai em `http://localhost:${PREVIEW_PORT}` quando a env var não está setada. Não há Traefik/nginx/TLS configurado em nenhum lugar do repo — isso ainda depende do passo 1 (Coolify) ser executado.
- Como o navegador acessa a Studio via `http://<IP-do-VPS>:3031` (nem `localhost`, nem HTTPS), `crypto.randomUUID`/`crypto.subtle` ficam indefinidos → dispara os erros #4 e #5 diretamente; os outros três são os catches downstream (`reportFailure`, ~linha 54171, e ~linha 60858) do mesmo erro.

Não dá para corrigir só editando este repo — o bundle da Studio não expõe fallback para os dois call sites. **A correção real é infraestrutura.**

### Passos de implementação

1. **⏳ Infra (Coolify) — pendente, requer acesso ao painel:** configurar o domínio `hf.consultorluizg.com.br` com HTTPS (Let's Encrypt automático) apontando para a porta 3031 do container `hyperframes-server`, do mesmo jeito que já deve existir para a porta 3030 (API). Checklist completo em [docs/deploy.md § HTTPS obrigatório para edição na Studio](deploy.md#https-obrigatório-para-edição-na-studio).
2. **✅ `docker-compose.yaml`:** default de `PUBLIC_PREVIEW_URL` ([linha 29](../docker-compose.yaml#L29)) trocado para `https://hf.consultorluizg.com.br`, e comentário (linhas 26-30) atualizado explicando que a URL precisa ser HTTPS/`localhost` — é requisito de *secure context* do navegador, não só "acessível".
3. **✅ `server.mjs` — warning em runtime:** em `POST /preview` ([server.mjs:216-231](../server.mjs#L216-L231)), loga `app.log.warn` quando `PUBLIC_PREVIEW_URL` começa com `http://` e o host não é `localhost`/`127.0.0.1`. Não bloqueia a criação do preview. Testado manualmente: warning dispara com host HTTP externo, não dispara com `localhost`.
4. **✅ `docs/deploy.md`:** nova seção "HTTPS obrigatório para edição na Studio" com a causa raiz e o passo a passo no Coolify para expor a porta 3031 com domínio + TLS.

### Verificação

1. ⏳ Após o passo 1 (Coolify) ser executado, abrir a Studio pela URL retornada por `POST /preview`, editar um elemento e confirmar que o save funciona.
2. ⏳ No console do navegador, confirmar `window.crypto.randomUUID` e `window.crypto.subtle` definidos.
3. ⏳ Confirmar com o(s) usuário(s) que os 5 erros pararam de ocorrer em uso real.

### Esforço estimado
Baixo (infra + ~15 linhas de código/doc). Código e docs já implementados; o que falta é só a config de TLS no Coolify (passo 1), fora do escopo deste repo.

---

## 2. Padrão modular de composições (`compositions/`) — ✅ concluído

### Status

Implementado e testado em 2026-08-15. `POST /preview` e `POST /render` aceitam o campo opcional `compositions` (array de `{path, content}`), materializado no disco via `writeCompositionFiles()` antes de rodar o CLI. `saveAsset()` também ganhou `mkdir(recursive:true)` + validação de path traversal. Ver [server.mjs](../server.mjs) (`assertSafeRelativePath`, `writeCompositionFiles`, `saveAsset`), [docs/preview.md](preview.md) e [docs/render.md](render.md).

Verificado manualmente (servidor local, sem Docker):
- Payload só com `html` (sem `compositions`) em `/preview` e `/render` — comportamento idêntico ao anterior (só `index.html` escrito em disco).
- Payload com `index.html` fino + `compositions/scene-1.html` + `compositions/scene-2.html` em `/preview` e `/render` — ambos os arquivos materializados em `compositions/` dentro do diretório de sessão; `hyperframes render` confirmou (via lint) que leu e processou os dois arquivos referenciados por `data-composition-src`.
- Path malicioso (`../../etc/passwd`, `/etc/passwd`) em `compositions[].path` e em `assets[].filename` — rejeitado com `400` e mensagem clara, nada escrito fora do diretório de sessão, `/etc/passwd` confirmado intacto.
- **Não verificado neste ambiente:** geração de MP4 real (ffmpeg/ffprobe não estão instalados na máquina de desenvolvimento local) — a lógica de materialização de arquivos foi validada, mas a renderização final ponta-a-ponta deve ser confirmada no ambiente Docker/Coolify de produção, que tem ffmpeg instalado.

### Motivação

Hoje o `index.html` de uma composição monta tudo inline: root → N `<div data-composition-id="scene-N" class="clip">` como filhos diretos, cada um com seu `<script>` logo depois. Isso fica difícil de revisar/editar conforme a composição cresce.

No padrão modular:
- `index.html` fica fino: só declara os slots — um `<div data-composition-src="compositions/scene-1.html" data-composition-id="scene-1" data-start="..." data-duration="..." class="clip">` vazio por cena — e registra uma timeline raiz quase vazia.
- Cada cena vira um arquivo próprio, `compositions/scene-N.html`, com um `<template>` contendo markup + `<style>` + `<script>` daquela cena.
- O runtime do `hyperframes` já sabe resolver `data-composition-src` (comportamento documentado do CLI: sub-composições via `<template>` referenciadas por `data-composition-src`) — clona o conteúdo do `<template>` para dentro do slot e resolve `window.__timelines["scene-N"]` como já faz hoje.

Ganho é só organização/legibilidade — não muda resultado final nem lógica de timing.

### Por que exige mudança no servidor

`POST /preview` e `POST /render` hoje aceitam um payload com **uma única string `html`** (mais `assets`). O servidor escreve essa string como `index.html` no diretório de sessão (`previewDir`/`jobDir`) e só depois roda `hyperframes preview`/`hyperframes render <dir>` apontando pra esse diretório.

`data-composition-src="compositions/scene-1.html"` é uma referência a arquivo relativo em disco, resolvida pelo navegador/CLI dentro do mesmo diretório de sessão. Como hoje só existe `index.html` (mais os `assets`) nesse diretório, qualquer `data-composition-src` vai dar 404 — o CLI já suporta projeto multi-arquivo (é assim que ele funciona quando rodado localmente contra uma pasta), só falta o servidor materializar mais de um arquivo de composição por sessão.

### Desenho proposto

Estender o schema de `POST /preview` ([server.mjs:171-215](../server.mjs#L171-L215)) e `POST /render` ([server.mjs:598-644](../server.mjs#L598-L644)) para aceitar arquivos de composição adicionais, mantendo `html` como está por compatibilidade:

```json
{
  "html": "<!-- conteúdo de index.html -->",
  "compositions": [
    { "path": "compositions/scene-1.html", "content": "<!-- <template>...</template> -->" },
    { "path": "compositions/scene-2.html", "content": "..." }
  ],
  "assets": [ { "filename": "...", "base64": "..." } ]
}
```
- `compositions` é opcional; se ausente, comportamento atual (arquivo único) não muda — **zero breaking change**.
- Reusar o mesmo formato `{path/filename, content}` dos `assets`, mas como texto (não base64), já que são arquivos HTML.

### Passos de implementação

1. **Helper compartilhado de escrita de arquivos** em `server.mjs`: extrair a lógica de `writeFile(join(dir, 'index.html'), html, 'utf8')` (hoje duplicada em [server.mjs:226](../server.mjs#L226) e [server.mjs:653](../server.mjs#L653)) para uma função `writeCompositionFiles(dir, html, compositions)` que:
   - Escreve `index.html`.
   - Para cada item de `compositions`, faz `mkdir(dirname(join(dir, path)), { recursive: true })` antes de `writeFile`, para suportar o subdiretório `compositions/`.
2. **Corrigir `saveAsset`** ([server.mjs:105-118](../server.mjs#L105-L118)): hoje `dest = join(dir, asset.filename)` sem `mkdir` — já quebra se algum asset vier com filename tipo `audio/narration.mp3`. Adicionar `mkdir(dirname(dest), { recursive: true })` antes de escrever, para consistência com o suporte a `compositions/`.
3. **Atualizar schema Fastify** de `POST /preview` e `POST /render` para incluir o campo `compositions` (array de `{path, content}`, ambos `required`), com validação de que `path` não escapa do diretório de sessão (evitar `../` — path traversal). Validar/sanitizar antes de `join()`.
4. **Chamar o helper** nos dois handlers no lugar do `writeFile` direto:
   - `POST /preview`: [server.mjs:226](../server.mjs#L226).
   - `POST /render`: [server.mjs:653](../server.mjs#L653).
5. **Atualizar `docs/preview.md` e `docs/render.md`** com o novo campo `compositions`, exemplo de payload multi-arquivo, e nota sobre `data-composition-src`.
6. **Lado n8n** (fora deste repo): o nó "Montar HTML Final" passaria a devolver um objeto com `html` + `compositions[]` em vez de só uma string `html`; os nós que chamam `/preview`/`/render` mandam esse objeto.

### Segurança

Validar `path` de cada item em `compositions` (e `filename` de cada `asset`) contra path traversal — rejeitar paths absolutos ou contendo `..` antes de `join(dir, path)`, para não permitir escrever fora do diretório de sessão.

### Verificação

1. Enviar um payload de teste com `index.html` fino + 2 `compositions/scene-N.html` para `POST /preview`; abrir a Studio e confirmar que as duas cenas renderizam.
2. Repetir para `POST /render` e conferir o MP4 final é idêntico ao gerado pelo `index.html` monolítico equivalente.
3. Testar payload sem `compositions` (só `html`) para confirmar que o comportamento atual não regrediu.
4. Testar `path` malicioso (`../../etc/passwd`) e confirmar que a rota rejeita com 400.

### Esforço estimado
Médio (~1 dia): schema + helper de escrita + validação de path traversal + docs. A resolução de `data-composition-src` em si já é responsabilidade do `hyperframes` CLI/bundle — não precisa ser reimplementada.
