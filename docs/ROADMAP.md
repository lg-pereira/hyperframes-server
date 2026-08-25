# Linha do tempo e aprendizados

Este documento não descreve o funcionamento do servidor — para isso, veja [docs/README.md](README.md) e os arquivos por endpoint. Aqui ficam **o que mudou, quando** e **o que se aprendeu apanhando**: as decisões técnicas e as armadilhas encontradas, para quem for mexer no código (ou numa integração parecida) não repetir os mesmos erros.

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

### 2026-08-24 — MCP de autoria ([PR #2](https://github.com/lg-pereira/hyperframes-server/pull/2))

`POST /mcp` expõe o contrato de composição e o catálogo de 372 templates como tools MCP, para um agente de IA consultar antes de gerar HTML — em vez de escrever animação de cabeça. Ver [docs/mcp.md](mcp.md).

### 2026-08-24 — Preview travado em produção ([PR #5](https://github.com/lg-pereira/hyperframes-server/pull/5))

Um servidor em produção ficou com `activePreview` apontando para uma Studio que não respondia mais: toda requisição às rotas proxiadas pendurava ~30s e terminava em `ECONNRESET`. Três correções em [server.mjs](../server.mjs): liberar o preview quando o processo morre, separar `headersTimeout` de `bodyTimeout` no proxy, e a rota `GET /preview` para inspecionar o estado.

### 2026-08-25 — Reabrir um preview ([PR #6](https://github.com/lg-pereira/hyperframes-server/pull/6))

Os arquivos de um preview sobreviviam 24h ao processo da Studio, mas só podiam ser **renderizados**: não havia rota para voltar a vê-los ou editá-los. `POST /preview` passou a aceitar `preview_id` além de `html` e reabre a Studio sobre o diretório existente — no lugar, mesmo id, edições preservadas. Kill-switch: `PREVIEW_REOPEN=false`.

### 2026-08-25 — Estabilidade do render: fila, retenção e órfãos

Um render de 733 frames ficou preso no frame 21 e morreu no timeout de 10 min. A causa imediata era a
composição (blur em vídeo de fundo, rasterizado em CPU por causa do `--no-browser-gpu`), mas a
investigação expôs quatro fragilidades independentes dela, todas em [server.mjs](../server.mjs):

- **Sem fila.** Todo `POST /render` spawnava na hora. Dois renders concorrentes com `RENDER_WORKERS=4`
  são 8 Chromiums disputando os mesmos cores e o mesmo `shm` — não dão dois renders lentos, dão dois
  timeouts. Agora o excedente recebe `429` com `Retry-After` e nenhum job é criado.
- **`hf_jobs` nunca varrido.** O único caminho de limpeza era o timer de 1 min disparado pelo
  *download*. Job que falhou, ou que ninguém baixou, ficava para sempre com os frames PNG
  intermediários. Retenção nova: 1h para erro, 24h para concluído, nunca para render em andamento.
- **SIGTERM não alcançava os filhos** (ver o aprendizado abaixo).
- **Sem rede de segurança.** Um varredor mata Chromium com `ppid=1` que sobreviva a duas passadas.

Tudo ligado por padrão, cada peça com kill-switch por env var. O teste de controle rodou os dois modos:
com `KILL_PROCESS_GROUP=false` os órfãos reaparecem, o que prova que foi a correção que os eliminou.

Tradeoff assumido: o `GET /logs` de um render que falhou expira em 1h junto com o job.

---

## Aprendizados

### "O bundle de terceiros não tem fallback" não significa que não dá para consertar

Este custou **semanas**. O roadmap afirmava que o save da Studio só se resolveria colocando HTTPS na frente do servidor, porque o bundle não expõe fallback nos dois call sites. A conclusão estava errada, e o passo de infra ficou parado enquanto os erros seguiam em produção.

O que faltava não era TLS, era um **ponto de injeção**. Nada obriga o servidor a entregar o HTML de terceiros sem tocá-lo: proxiando, dá para injetar um `<script>` que roda antes do bundle.

> A falta de fallback limita o que dá para consertar **dentro** do bundle — não o que dá para consertar no caminho até o navegador.

Quando um documento disser "só dá para resolver com infra", desconfie e procure onde o controle ainda é seu.

### Leia o formato cru, não a saída normalizada do CLI

O `hyperframes catalog --json` devolve itens com `tags`, `title` e `type: "block"`. O `registry.json` real é um índice fino: só `name` e `type`, prefixado (`hyperframes:block`), sem tags. O CLI normaliza e hidrata.

Duas suposições erradas viraram bugs por se ter olhado a saída bonita em vez do arquivo de origem. Ao integrar com um formato de terceiros, busque o arquivo cru.

### Idade de cache pode ser negativa

`Date.now() - mtimeMs` fica abaixo de zero quando o mtime está à frente do relógio (skew de filesystem, container, NFS). Com `ageMs < TTL` como teste de frescor, a entrada vira "mais fresca que agora" e **nunca expira**.

Foi um bug não determinístico — passou num script e falhou noutro, o que foi exatamente o que o denunciou. Sempre `Math.max(0, ...)` na idade.

### SSE atrás de proxy precisa de flush explícito

O Node só envia os headers da resposta quando sai o primeiro byte de corpo. Um endpoint SSE que fica calado até algum evento acontecer (como o `/api/events` da Studio) deixa o `EventSource` do navegador pendurado esperando headers que nunca chegam — e o live-reload simplesmente não conecta.

O servidor original fazia esse flush sozinho. Ao proxiar, ele passa a ser responsabilidade de quem proxia: `reply.raw.flushHeaders()`.

No mesmo caminho: force `accept-encoding: identity` quando for transformar o corpo, senão a injeção cai em cima de bytes comprimidos.

### Pipelines que remontam objetos campo a campo descartam campos silenciosamente

Um passo que reconstrói o payload explicitamente (`{ a: x.a, b: x.b }`) perde qualquer campo novo, sem erro nem aviso. É o padrão em ferramentas de automação com nós de código, mas vale para qualquer camada de transformação.

Ao propagar um campo novo (como o `preview_id`) por um pipeline, percorra **todos** os passos do caminho: numa integração real foram quatro, não dois, e os dois que faltavam só apareceram rastreando o dado ponta a ponta.

### Não silencie um aviso de validação para "passar"

Ao montar uma composição de teste, o `hyperframes check` acusou sobreposição de texto no crossfade. O aviso foi silenciado com `data-layout-allow-overlap` — e o snapshot mostrou que o checker estava certo: os dois títulos ficavam legíveis ao mesmo tempo na mesma posição, virando um borrão.

Esse atributo existe para sobreposição **intencional**. Usá-lo para calar um achado legítimo esconde o defeito e ainda desativa outras checagens na subárvore. A correção certa era o timing.

(Outro detalhe do contrato: `data-start="0"` é obrigatório na raiz — o `lint` reprova sem ele, embora o exemplo mínimo da skill o omita.)

### Sem ffmpeg local, o MP4 não é validável localmente

`POST /render` falha com "FFmpeg not found" numa máquina sem ffmpeg/ffprobe, mesmo com todo o resto correto — e é fácil confundir isso com um defeito da composição. O container do `Dockerfile` já traz Chromium e FFmpeg; fora dele, instale os dois ou renderize num ambiente que os tenha.

Valide localmente o que der (`npm test`, `/lint`, `/check`, `/preview`, os endpoints de estado) e **diga explicitamente** que o MP4 ficou pendente — não afirme que o render funciona sem ter visto.

### Mudanças aditivas, opt-in, com regressão testada primeiro

O padrão que funcionou nas PRs deste repositório, e que evitou uma regressão real:

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

### Dado que sobrevive ao processo precisa de um caminho de volta

Os arquivos do preview passaram a ser retidos por 24h para que `POST /render {preview_id}` renderizasse as edições salvas. Só que a única porta para aquele diretório era o render: com a Studio encerrada, não dava mais para **ver** nem editar o que estava lá — e recuperar significava reenviar o HTML original, descartando justamente as edições que a retenção existia para preservar.

Ao decidir reter um dado além da vida do processo que o criou, pergunte quais operações ele ainda precisa aceitar depois. Reter só para uma delas cria um estado semi-acessível, que parece perda de dados para quem usa.

Na implementação, dois detalhes fizeram diferença: o caminho de reabertura **não** pode compartilhar a limpeza de erro do caminho de criação (apagar o diretório num spawn que falhou destruiria as edições), e reabrir precisa renovar o relógio da retenção, senão a varredura leva o diretório no meio da sessão.

### Cache de conteúdo remoto precisa de um degrau stale

Cache fresco → rede → **cache velho com aviso**. O último degrau é o que impede uma indisponibilidade do GitHub de travar a geração de uma cena. Falhar de verdade só quando não há cache nem rede.

E quando o upstream publica uma revisão, use-a como chave do cache agregado em vez de adivinhar um TTL.

### SIGTERM não atravessa a árvore de processos — e `execFile` não deixa consertar

O timeout do render usava a opção `timeout` do `execFile`. Ela sinaliza **um PID**: o do CLI. Os
workers Chromium, filhos dele, não recebem nada — são reparentados para o PID 1 e seguem vivos,
consumindo CPU e `shm` até o container reiniciar. Num container com `init: true` isso é pior do que
parece: o tini *reapa zumbi*, mas não mata órfão vivo, então o vazamento é invisível em `ps` para quem
procura processo defunct.

A correção é `kill(-pid)`, que sinaliza o grupo inteiro, e ela exige que o filho seja líder de um grupo
novo — `detached: true`. O detalhe que custou uma sessão de depuração:

> **`execFile` descarta `detached` em silêncio.** Ele repassa ao `spawn` apenas uma whitelist de opções
> (`cwd`, `env`, `uid`, `gid`, `shell`, `signal`, `windowsHide`, `windowsVerbatimArguments`). Passar
> `detached: true` para `execFile` não gera erro nem aviso: o filho herda o grupo do servidor, e o
> `kill(-pid)` falha com `ESRCH` — ou, num azar de pid, acertaria o próprio servidor.

Só o `spawn` aceita. Por isso os três pontos que abrem browser (render, check, preview) usam `spawn`, e
o que se perde na troca (`maxBuffer`) foi reimplementado como teto explícito de log.

Verificar valeu mais que ler a documentação: `ps -o pgid=` no filho mostrou o grupo herdado em um
segundo, enquanto a doc do `detached` descreve o comportamento pretendido sem mencionar a whitelist.

### `detached: true` obriga a ter handler de saída

Um filho em grupo/sessão própria **não** morre junto com o pai, e não recebe o Ctrl+C do terminal. Sem
`process.on("SIGTERM"/"SIGINT")` matando os grupos registrados, a correção do vazamento no timeout
criaria um vazamento no restart. É a mesma lição do registro de processo em memória, um degrau acima:
não basta saber quem está vivo, é preciso um caminho que os encerre quando o servidor sai.
