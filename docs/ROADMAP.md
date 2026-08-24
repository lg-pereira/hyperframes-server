# Linha do tempo e aprendizados

Este documento não descreve o funcionamento do servidor — para isso, veja [docs/README.md](README.md) e os arquivos por endpoint. Aqui ficam só **o que mudou, quando** e **o que aprendemos apanhando**, para uma sessão futura não repetir os mesmos erros.

---

## Linha do tempo

### 2026-08-15 — Composições modulares

`POST /preview` e `POST /render` passaram a aceitar `compositions[]` (`{path, content}`), materializado em disco por `writeCompositionFiles()` antes de rodar o CLI, permitindo `index.html` fino + `compositions/scene-N.html` via `data-composition-src`. `saveAsset()` ganhou `mkdir` recursivo e validação de path traversal.

No mesmo dia, `POST /lint` e `POST /check` ganharam o mesmo campo, reusando o helper sem reimplementar nada — antes não havia como validar uma composição modular sem gastar um preview ou render real.

`/lint` ficou deliberadamente **sem** `assets`: ele é validação puramente estrutural, e nenhuma regra depende de um arquivo de mídia existir. `/check` continua sendo o endpoint para validar com mídia presente.

### 2026-08-23 — A Studio passou a salvar de verdade ([PR #1](https://github.com/lg-pereira/hyperframes-server/pull/1))

O bundle da Studio chama `crypto.randomUUID()` e `crypto.subtle.digest()` sem fallback, e as duas APIs só existem em secure context. Servida em `http://<IP>:3031`, toda edição falhava ao salvar.

A Studio passou a ser proxiada pela porta da API, o que criou o ponto de injeção para [studio-polyfill.js](../studio-polyfill.js) entrar no `<head>` antes do bundle. **Salvar funciona em HTTP puro, sem TLS.**

Junto veio o fechamento do ciclo: `POST /render` aceita `preview_id`, renderizando o diretório do preview já editado, e os arquivos do preview passaram a ser retidos por 24h em vez de apagados no próximo preview.

### 2026-08-24 — n8n usando `preview_id`

O `preview_id` já era gravado na fila, mas nunca chegava ao corpo do `POST /render` — o fluxo renderizava o HTML antigo e descartava as edições. Corrigido em **quatro** nós de `[Video] Aprovador` (`eW99QxR0gDLYm61i`) e `[Video] Hyperframes Preview` (`jJArK7nS7xu2FjQo`): `Montar Chamada Render`, `Montar Manifesto`, `Usar HTML Existente` e `Solicitar Render`.

Ponto crítico do desenho: o `html` **continua sendo enviado**. Ele alimenta o IF `Tem HTML Pronto?`, cujo ramo falso re-gera o vídeo inteiro com IA. Quem escolhe entre `preview_id` e `html` é o ternário do `Solicitar Render`, no corpo HTTP — não o roteamento.

**Pendente:** o remendo em `Montar Retorno` que troca `localhost` por IP na `preview_url` pode sair quando `PUBLIC_BASE_URL` estiver definida.

### 2026-08-24 — MCP de autoria ([PR #2](https://github.com/lg-pereira/hyperframes-server/pull/2))

`POST /mcp` expõe o contrato de composição e o catálogo de 372 templates como tools MCP, para o agente do n8n consultar antes de gerar HTML. Ver [docs/mcp.md](mcp.md).

**Pendente:** medir a taxa de erro do nó `Checar Composição` antes e depois — é a única métrica objetiva de que o MCP melhorou a geração.

### 2026-08-24 — Preview travado em produção

A VPS ficou com `activePreview` apontando para uma Studio que não respondia mais: toda requisição às rotas proxiadas pendurava ~30s e terminava em `ECONNRESET`. Três correções em [server.mjs](../server.mjs): liberar o preview quando o processo morre, separar `headersTimeout` de `bodyTimeout` no proxy, e a rota `GET /preview` para inspecionar o estado.

---

## Aprendizados

### "O bundle de terceiros não tem fallback" não significa que não dá para consertar

Este custou **semanas**. O roadmap afirmava que o save da Studio só se resolveria com HTTPS no Coolify, porque o bundle não expõe fallback nos dois call sites. A conclusão estava errada, e o passo de infra ficou parado enquanto os erros seguiam em produção.

O que faltava não era TLS, era um **ponto de injeção**. Nada obriga o servidor a entregar o HTML de terceiros sem tocá-lo: proxiando, dá para injetar um `<script>` que roda antes do bundle.

> A falta de fallback limita o que dá para consertar **dentro** do bundle — não o que dá para consertar no caminho até o navegador.

Quando um documento disser "só dá para resolver com infra", desconfie e procure onde o controle ainda é nosso.

### Leia o formato cru, não a saída normalizada do CLI

O `hyperframes catalog --json` devolve itens com `tags`, `title` e `type: "block"`. O `registry.json` real é um índice fino: só `name` e `type`, prefixado (`hyperframes:block`), sem tags. O CLI normaliza e hidrata.

Duas suposições erradas viraram bugs por eu ter olhado a saída bonita em vez do arquivo de origem. Ao integrar com um formato de terceiros, busque o arquivo cru.

### Idade de cache pode ser negativa

`Date.now() - mtimeMs` fica abaixo de zero quando o mtime está à frente do relógio (skew de filesystem, container, NFS). Com `ageMs < TTL` como teste de frescor, a entrada vira "mais fresca que agora" e **nunca expira**.

Foi um bug não determinístico — passou num script e falhou noutro, o que foi exatamente o que o denunciou. Sempre `Math.max(0, ...)` na idade.

### SSE atrás de proxy precisa de flush explícito

O Node só envia os headers da resposta quando sai o primeiro byte de corpo. Um endpoint SSE que fica calado até algum evento acontecer (como o `/api/events` da Studio) deixa o `EventSource` do navegador pendurado esperando headers que nunca chegam — e o live-reload simplesmente não conecta.

O servidor original fazia esse flush sozinho. Ao proxiar, virou responsabilidade nossa: `reply.raw.flushHeaders()`.

No mesmo caminho: force `accept-encoding: identity` quando for transformar o corpo, senão a injeção cai em cima de bytes comprimidos.

### Nós de código do n8n descartam campos silenciosamente

Nós que remontam o objeto campo a campo (`return [{ json: { a: x.a, b: x.b } }]`) perdem qualquer campo novo, sem erro nem aviso. Ao propagar um campo por um fluxo, é preciso percorrer **todos** os nós de código do caminho — foram quatro, não dois, e os dois que faltavam eram invisíveis até rastrear o dado ponta a ponta.

### Não silencie um aviso de validação para "passar"

Ao montar uma composição de teste, o `hyperframes check` acusou sobreposição de texto no crossfade. Silenciei com `data-layout-allow-overlap` e segui. O snapshot mostrou que o checker estava certo: os dois títulos ficavam legíveis ao mesmo tempo na mesma posição, virando um borrão.

Esse atributo existe para sobreposição **intencional**. Usá-lo para calar um achado legítimo esconde o defeito e ainda desativa outras checagens na subárvore. A correção certa era o timing.

(Outro detalhe do contrato: `data-start="0"` é obrigatório na raiz — o `lint` reprova sem ele, embora o exemplo mínimo da skill o omita.)

### O MP4 só pode ser validado na VPS

A máquina de desenvolvimento não tem ffmpeg/ffprobe. `POST /render` sempre falha localmente com "FFmpeg not found", mesmo com todo o resto correto.

Valide localmente o que der (`npm test`, `lint`, `check`, `snapshot`, os endpoints) e **diga explicitamente** que o MP4 ficou pendente — não afirme que o render funciona sem ter visto.

### Mudanças aditivas, opt-in, com regressão testada primeiro

O padrão que funcionou nas duas PRs, e que evitou uma regressão real:

- **Rotas explícitas, nunca catch-all.** A primeira proposta do proxy da Studio usava catch-all na porta da API; isso faria toda rota inexistente devolver o HTML do SPA em vez do 404 JSON do Fastify.
- **Comportamento novo atrás de env var opt-in**, com o valor antigo como padrão (`PUBLIC_BASE_URL`), mais um kill-switch (`STUDIO_PROXY`, `MCP_ENABLED`). Rollback é remover a variável, não fazer deploy.
- **Bloco de regressão rodando antes** do teste da funcionalidade nova, provando que o fluxo atual está intacto.
- **Teste de controle**, quando possível: a 3031 continuar falhando ao salvar é o que prova que foi o polyfill que corrigiu, e não outra coisa.

### Processo externo em registro na memória precisa de handler de saída

O servidor guardava o processo da Studio em `activePreview` e roteava o proxy por ele. O `proc.on("exit")` existia, mas só cobria a falha **antes** do preview ficar pronto. Depois disso, se o processo morresse, o registro apodrecia: o proxy seguia mandando tráfego para uma porta morta, indefinidamente, sem erro que ajudasse a diagnosticar.

Sempre que um processo externo entra num registro em memória do qual outra parte do sistema depende, o handler de saída é obrigatório — e precisa ser guardado (`activePreview?.proc !== proc`), senão ele dispara para um processo já substituído e derruba o preview novo.

### Um timeout zerado por um motivo pode travar outro caminho

O `headersTimeout: 0` do proxy tinha sido posto para o SSE do live-reload. Mas SSE precisa apenas que o **corpo** fique aberto: os headers chegam de imediato em qualquer resposta sadia. Zerar os dois transformou "esperar o stream" em "esperar para sempre", e foi o que fez uma Studio travada pendurar cada requisição por 30s.

`bodyTimeout: 0` e `headersTimeout` finito atendem os dois casos. Antes de zerar um timeout, verifique exatamente qual fase ele cobre.

### Estado interno precisa de uma rota que o mostre

O `DELETE /preview/:id` exigia o `preview_id` exato do ativo, e não havia rota que o revelasse. Com o servidor travado, não dava nem para saber o que limpar — o diagnóstico só avançou lendo o código.

Se uma operação exige um identificador, alguma rota tem que devolvê-lo.

### Cache de conteúdo remoto precisa de um degrau stale

Cache fresco → rede → **cache velho com aviso**. O último degrau é o que impede uma indisponibilidade do GitHub de travar a geração de uma cena. Falhar de verdade só quando não há cache nem rede.

E quando o upstream publica uma revisão, use-a como chave do cache agregado em vez de adivinhar um TTL.
