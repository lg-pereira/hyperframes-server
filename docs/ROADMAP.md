# Roadmap

Histórico de features implementadas (e uma pendência de infra). Cada seção documenta causa raiz / motivação, desenho proposto e passos de implementação com referências de arquivo, para que qualquer pessoa (ou uma sessão futura do Claude) possa pegar e executar sem precisar reinvestigar do zero.

---

## 1. Salvar edições na Studio — ✅ resolvido em código (sem depender de infra)

### Status

Resolvido. A Studio passou a ser servida pela porta da API (3030) via proxy, o que deu ao servidor um ponto de injeção para o polyfill de secure context. **Salvar edições funciona em HTTP puro** — nenhuma configuração de TLS é necessária. Ver [server.mjs](../server.mjs) (seção "Proxy da Studio"), [studio-polyfill.js](../studio-polyfill.js) e [docs/deploy.md § Edição na Studio](deploy.md#edição-na-studio-salvar--como-funciona).

### Correção de rumo

A versão anterior desta seção concluía que **"não dá para corrigir só editando este repo — a correção é infraestrutura (HTTPS no Coolify)"**. Isso estava **errado**, e a conclusão custou tempo: o passo de infra ficou pendente por semanas enquanto os erros continuavam em produção.

O que faltava não era TLS, era um **ponto de injeção**. O bundle da Studio de fato não tem fallback nos dois call sites — mas nada obriga o servidor a entregar o HTML da Studio sem tocá-lo. Proxiando a Studio pela porta da API, o servidor injeta um `<script>` no `<head>` (antes do bundle, que é `type="module"` e portanto deferido) e define `crypto.randomUUID`/`crypto.subtle.digest` antes de qualquer código da Studio rodar.

Lição: "o bundle de terceiros não tem fallback" limita o que dá para consertar **dentro** do bundle, não o que dá para consertar no caminho até o navegador.

### Motivação

Usuários reportam estes erros ao editar vídeos na Studio (preview embutido, servido por `hyperframes preview` via `POST /preview`):

- `Couldn't save index.html / index2.html — your latest edits are NOT persisted...`
- `Failed to save animated edit.`
- `Cannot read properties of undefined (reading 'digest')`
- `Couldn't save "Scene5 Stat Num": globalThis.crypto.randomUUID is not a function`

### Causa raiz (confirmada por leitura de código)

- `node_modules/hyperframes/dist/studio/index.js` usa `globalThis.crypto.randomUUID()` sem fallback em `createStudioWriteToken()`, que monta o header `X-Hyperframes-Write-Token` de **toda** mutação (save de HTML, edição animada, corte/split).
- Também usa `globalThis.crypto.subtle.digest("SHA-256", ...)` sem guarda em `studioFileContentVersion()`, usado na checagem de concorrência otimista antes de cada save.
- `crypto.randomUUID` e `crypto.subtle` só existem no navegador em **contexto seguro** (HTTPS ou `localhost`). Fora disso, ambos são `undefined`.
- O deploy servia a Studio em HTTP puro (`http://<IP>:3031`) — nem `localhost`, nem HTTPS. Os erros #4 e #3 são os diretos; os outros são os catches downstream do mesmo erro.

### O que foi implementado

1. **[studio-polyfill.js](../studio-polyfill.js):** reimplementa `crypto.randomUUID` (UUID v4 sobre `crypto.getRandomValues`, que **não** é secure-context gated), `crypto.subtle.digest("SHA-256")` (JS puro) e `navigator.clipboard.writeText`. Tudo sob guarda — em HTTPS/`localhost` é no-op completo.
2. **Proxy da Studio em [server.mjs](../server.mjs):** rotas explícitas (`/`, `/studio`, `/__hyperframes_config`, `/api/*`, `/assets/*`, `/icons/*`, `/favicon.svg`) — as rotas de topo do app Hono da Studio, nenhuma delas existente nesta API. Sem catch-all, para não alterar o 404 de nenhuma rota atual. O HTML é o único response bufferizado (para a injeção); o resto passa como stream.
3. **`PUBLIC_BASE_URL`:** define para onde `preview_url` aponta. Sem ela, o comportamento é idêntico ao anterior — a migração é opt-in e o rollback é remover a variável. `STUDIO_PROXY=false` desliga o proxy inteiro.
4. **[test/polyfill.test.mjs](../test/polyfill.test.mjs) (`npm test`):** compara o SHA-256 do polyfill com `node:crypto` nos casos de borda do padding, UTF-8 multibyte e payload grande. Um hash divergente não daria erro visível — a Studio calcularia uma versão de arquivo que não bate com a do servidor e todo save morreria em `409 conflict`.

### Verificação

Feita localmente (ver §3 para o que depende de Docker):

- ✅ Save real através do proxy: o SHA-256 do polyfill bate com o `fileContentVersion` do servidor, o `X-Hyperframes-Write-Token` atravessa intacto, `PUT` responde 200 e o arquivo em disco muda.
- ✅ Live-reload (SSE `/api/events`) entregando `file-change` através do proxy.
- ✅ Rotas atuais inalteradas, inclusive o 404 de rota inexistente.
- ⏳ Confirmar com o(s) usuário(s) que os erros pararam de ocorrer em uso real, na VPS.

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
    {
      "path": "compositions/scene-1.html",
      "content": "<!-- <template>...</template> -->"
    },
    { "path": "compositions/scene-2.html", "content": "..." }
  ],
  "assets": [{ "filename": "...", "base64": "..." }]
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

## 3. Estender `/check` e `/lint` pra aceitar `compositions[]` — ✅ concluído

### Status

Implementado e testado em 2026-08-15. `POST /check` e `POST /lint` aceitam o campo opcional `compositions` (array de `{path, content}`), materializado no disco via o helper `writeCompositionFiles()` já existente (reusado tal como estava, sem reimplementação). Ver [server.mjs](../server.mjs) (rotas `/lint` e `/check`), [docs/lint.md](lint.md) e [docs/check.md](check.md).

**Decisão sobre `assets` em `/lint` (ponto 5 do desenho proposto):** optou-se por **não** adicionar `assets` a `/lint` — ficou só com `compositions`. Motivo: `/lint` já era documentado como validação puramente estrutural do HTML, sem abrir browser e sem tocar em mídia real (`docs/lint.md` já dizia "Não valida assets (imagens, áudio) — apenas a estrutura do HTML" antes desta mudança); `compositions` é necessário porque o `hyperframes lint` resolve `data-composition-src` contra o diretório, mas nenhuma regra de lint depende de um asset existir fisicamente em disco. `/check` continua sendo o endpoint indicado quando for preciso validar com assets presentes (layout/contraste).

Verificado manualmente (servidor local, sem Docker):

- Payload só com `html` (sem `compositions`) em `/check` e `/lint` — comportamento idêntico ao anterior (mesmos achados de baseline, nenhuma mudança de comportamento).
- Payload com `index.html` fino + `compositions/scene-1.html` + `compositions/scene-2.html` em `/lint` — `valid: true`, sem erro de sub-composição ausente.
- Mesmo payload em `/check` — nenhum erro de arquivo/sub-composição ausente; os achados retornados (`studio_missing_editable_id`, `root_composition_missing_data_start`, etc.) referenciam `scene-1` e `scene-2` diretamente, confirmando que o `hyperframes check` processou o conteúdo real das cenas, não só um root vazio.
- Path malicioso (`../../etc/passwd`) em `compositions[].path` em `/lint` e `/check` — ambos rejeitados com `400` e a mensagem padrão de `assertSafeRelativePath()`; `/etc/passwd` confirmado intacto; nenhum diretório temporário deixado para trás (`/tmp/hf-jobs` limpo em ambos os casos, inclusive no caminho de erro).
- **Não verificado neste ambiente:** o mesmo caveat do item 2 — ffmpeg/ffprobe não estão instalados na máquina de desenvolvimento local, mas `/check` e `/lint` não geram vídeo, então isso não bloqueia a verificação destes dois endpoints especificamente.

Deploy no VPS confirmado em 2026-08-15 (Coolify, redeploy manual — mesmo processo do item 1). Verificado contra produção (`http://100.121.2.102:3030`, Tailscale-only) após o redeploy:

- `GET /health` respondeu com `uptime` baixo logo após o redeploy, confirmando container novo; `GET /docs/json` (Swagger) passou a listar `compositions` no schema de `/check` e `/lint` (antes só existia em `/preview`/`/render`).
- Payload só com `html` (sem `compositions`) em `/check` e `/lint` — `/check` reportou os achados estruturais esperados do fragmento de teste (`missing_timeline_registry`, `studio_missing_editable_id`, etc.), `/lint` retornou `valid:true` — nenhum erro relacionado a arquivo/sub-composição ausente, comportamento consistente com o esperado sem `compositions`.
- Payload com `index.html` fino + `compositions/scene-1.html` + `compositions/scene-2.html` em `/check` — achados (`studio_missing_editable_id`, `root_composition_missing_data_start`, etc.) referenciam `scene-1` e `scene-2` diretamente, confirmando que o servidor de produção materializou e processou o conteúdo real das duas cenas.
- Mesmo payload em `/lint` — `valid:true`, sem erro de sub-composição ausente.
- Path malicioso (`../../etc/passwd`) em `compositions[].path` — `/check` e `/lint` rejeitaram ambos com `400` e a mensagem padrão de `assertSafeRelativePath()`.

### Motivação

O item 2 deste roadmap adicionou suporte a `compositions[]` (sub-composições via `data-composition-src`) em `POST /preview` e `POST /render`, mas não em `POST /check` nem `POST /lint`. Isso significa que, hoje, não existe forma de validar uma composição modular (`index.html` fino + `compositions/scene-N.html`) antes de gastar um preview ou render real — qualquer tentativa de rodar `/check`/`/lint` contra um `index.html` que referencia `data-composition-src="compositions/scene-1.html"` vai falhar, porque o servidor nunca materializa esse arquivo no diretório temporário de check/lint.

### Causa raiz (confirmada por leitura de código)

- `POST /check` ([server.mjs:493-654](../server.mjs#L493-L654)) desestrutura `const { html, assets = [], strict = false, samples, at, tolerance, contrast = true } = req.body;` ([server.mjs:575](../server.mjs#L575)) — sem `compositions`. Escreve só `index.html` ([server.mjs:582](../server.mjs#L582)) + assets via `saveAsset()` — nunca chama `writeCompositionFiles()`.
- `POST /lint` ([server.mjs:351-...](../server.mjs#L351)) desestrutura só `const { html } = req.body;` ([server.mjs:391](../server.mjs#L391)) — mesma lacuna, nem `assets` aceita.
- O helper `writeCompositionFiles(dir, html, compositions)` ([server.mjs:132](../server.mjs#L132)) já existe e já é reusado por `/preview` e `/render` — é só chamá-lo nos outros dois handlers.

### Desenho proposto

Espelhar exatamente o que já foi feito em `/preview`/`/render` (item 2 deste roadmap):

1. Adicionar `compositions` ao schema Fastify de `POST /check` e `POST /lint` — mesmo formato já usado nos outros dois (`array` de `{path, content}`, ambos `required`, com a mesma descrição/validação de path traversal).
2. Trocar `await writeFile(join(checkDir, 'index.html'), html, 'utf8')` (`/check`, linha 582) por `await writeCompositionFiles(checkDir, html, compositions)`.
3. Trocar `await writeFile(lintFile, html, 'utf8')` (`/lint`, linha 400) por `await writeCompositionFiles(lintDir, html, compositions)` — ajustar a assinatura já que hoje `/lint` calcula `lintFile` como um caminho específico; `writeCompositionFiles` espera o diretório, não o arquivo.
4. `/check` já aceita e usa `assets` — só adicionar `compositions` ao destructure da linha 575 e ao schema `properties`.
5. `/lint` **não aceita `assets` hoje** — decidir se vale adicionar `assets` também (pra lint conseguir referenciar mídia por nome sem erro, se o CLI reclamar de arquivo ausente) ou deixar `/lint` só com `compositions` por ora, já que hoje ele nunca precisou de assets pra validação puramente estrutural.
6. Atualizar `docs/lint.md` e `docs/check.md` com o novo campo `compositions`, exemplo de payload modular (mesmo exemplo já usado em `docs/preview.md`/`docs/render.md`).

### Segurança

Reusar a mesma validação de path traversal que `writeCompositionFiles()`/`assertSafeRelativePath()` já fazem para `/preview`/`/render` — nenhuma validação nova precisa ser escrita, só reaproveitar o helper existente.

### Passos de implementação

1. `server.mjs`: editar rota `/check` (linhas ~493-654) — schema + destructure + chamada ao helper.
2. `server.mjs`: editar rota `/lint` (linhas ~351-...) — schema + destructure + chamada ao helper (decidir sobre `assets`, ver ponto 5 acima).
3. `docs/check.md` e `docs/lint.md`: documentar `compositions`, com o mesmo exemplo de payload modular usado em `docs/preview.md`.
4. Deploy no VPS (mesmo processo do item 1/2 deste roadmap).

### Verificação

1. Payload só com `html` (sem `compositions`) em `/check` e `/lint` — comportamento idêntico ao atual (regressão zero).
2. Payload com `index.html` fino + 2 `compositions/scene-N.html` em `/check` — confirmar que não retorna mais erro de arquivo/sub-composição ausente, e que os achados de lint/runtime/layout refletem o conteúdo real das cenas (não só do root vazio).
3. Mesmo teste em `/lint`.
4. Path malicioso (`../../etc/passwd`) em `compositions[].path` — confirmar rejeição com `400`, igual a `/preview`/`/render`.

### Esforço estimado

Baixo (~1-2h) — mudança mecânica, reusa 100% da infraestrutura (`writeCompositionFiles`, validação de path) já implementada e testada no item 2.

---

## 4. Renderizar as edições feitas na Studio (`preview_id`) — ✅ concluído em código, ⏳ MP4 a validar no Docker

### Status

Implementado junto com o item 1. Sem ele, corrigir o save não resolveria nada na prática: dava para salvar, mas não para renderizar o que foi salvo.

### Motivação

Mesmo com o save funcionando, o ciclo não fechava. A Studio grava em `/tmp/hf-previews/{previewId}/index.html`, mas:

- `POST /render` só aceitava `html` no corpo — renderizar depois de editar significava reenviar o HTML **antigo**, jogando fora a edição;
- `killActivePreview()` apagava o diretório no próximo `POST /preview` e no TTL de 2h, então as edições sumiam.

O usuário editava na Studio, via o preview correto, mandava renderizar — e recebia o vídeo **sem** as edições.

### O que foi implementado

1. **`POST /render` aceita `preview_id`** como alternativa a `html`: copia o diretório do preview (com as edições) para o `jobDir` e segue pelo mesmo pipeline de render, sem nenhuma alteração no `execFile`/status/download. Copiar em vez de renderizar no lugar deixa o job independente do preview.
2. **`html` e `preview_id` são mutuamente exclusivos** — os dois juntos retornam `400`. Aceitar ambos seria ambíguo justamente no caso que importa. O `preview_id` é validado contra o formato de `randomUUID()`, o que também barra traversal.
3. **Retenção:** `killActivePreview()` deixou de apagar os arquivos. A limpeza passou a ser por `PREVIEW_RETENTION_MS` (24h, varredura de hora em hora que nunca remove o preview ativo) ou por `DELETE /preview/:id?purge=true`. É a única mudança de comportamento em algo que já funcionava; o efeito colateral é uso de disco no volume `hf_previews`, contido pela varredura.

### Ganhos colaterais

- O payload do render fica minúsculo: os assets já estão no diretório do preview, então nada de base64 no corpo — some o limite de tamanho do JSON.
- Previews concorrentes deixam de atropelar: um novo `POST /preview` encerra o processo do anterior, mas os arquivos ficam, então o `preview_id` antigo continua renderizável.

### Integração no n8n

O sub-workflow `[Video] Hyperframes Preview` já devolve `preview_id` ao workflow pai. As mudanças são pequenas:

1. **`Solicitar Render`** — `jsonBody` vira um ternário: com `preview_id`, manda `{ preview_id, fps }`; senão mantém o payload atual.
2. **`Composicao Pronta`** — o guard `if (d.html === undefined)` precisa virar `if (d.html === undefined && d.preview_id === undefined)`, senão o fluxo cai no fallback `Extrair HTML` e reconstrói a composição antiga.
3. **Workflow pai** — guardar o `preview_id` e mandá-lo junto de `mode: "render"` na confirmação.
4. **`Montar Retorno`** — o remendo que troca `localhost` por IP na `preview_url` pode sair depois que `PUBLIC_BASE_URL` estiver definida.

### Verificação

- ✅ `POST /render {preview_id}` leva o HTML **editado** para o `jobDir`.
- ✅ Bordas: `html`+`preview_id` → 400; nenhum dos dois → 400; `preview_id` inexistente → 404; `../../etc` → 400.
- ✅ `POST /render {html}` inalterado, `compositions` e a validação de traversal intactos.
- ⏳ **MP4 final:** não validável na máquina de desenvolvimento (sem ffmpeg/ffprobe). O render chegou até o CLI com o HTML certo e falhou exatamente em "FFmpeg not found". Precisa ser confirmado no ambiente Docker/Coolify.
