// Quando o desfecho de um processo filho é final.
//
// O erro que este módulo existe para não repetir: concluir o job no evento
// `close`. O `close` só dispara quando o processo morreu **e todos os pipes de
// stdio fecharam** — e o write-end desses pipes é herdado por cada neto. O CLI do
// hyperframes deixa um Chromium para trás quando o render falha; esse Chromium
// segura o stdout herdado, e o `close` do CLI nunca chega.
//
// Na VPS isso apareceu assim: o CLI imprimiu "Render failed" aos 12,5s, saiu, e
// o job ficou em "processing" por 1800s — até o timeout do servidor matar o grupo
// e finalmente fechar o pipe. Com MAX_CONCURRENT_RENDERS=1, esses 30 minutos são
// o endpoint inteiro devolvendo 429.
//
// O `exit` não tem esse problema: chega assim que o processo morre e já traz o
// código real. Por isso a regra aqui é — desfecho vem do `exit`; o `close` vira
// só o sinal de "o log terminou de drenar", com uma janela curta. Se a janela
// vence, sobrou processo segurando os pipes: mata o grupo e conclui assim mesmo.
//
// Vive fora do server.mjs porque importar aquele arquivo sobe o servidor.

// Janela para o stdout/stderr drenarem depois do exit. Curta de propósito: no
// caminho normal o close chega em milissegundos, e quando não chega é porque
// sobrou neto vivo — esperar mais não traz log nenhum.
export const DEFAULT_DRAIN_MS = 3_000;

// Registra os handlers de desfecho em `proc` e garante que `onSettled` roda
// EXATAMENTE uma vez, com { code, signal, error, leaked }:
//
//   error   → o processo nem chegou a rodar (ENOENT no binário e afins)
//   leaked  → o exit veio, mas o close não: alguém herdou os pipes
//
// `killLeftovers` é chamado só no caso `leaked`, para reapar o que sobrou.
export function settleOnExit(
  proc,
  { drainMs = DEFAULT_DRAIN_MS, onSettled, killLeftovers = () => {} } = {},
) {
  let settled = false;
  const settle = (outcome) => {
    if (settled) return;
    settled = true;
    onSettled(outcome);
  };

  // "error" pode vir sozinho ou acompanhado de "close": o guarda acima é o que
  // impede o segundo desfecho de sobrescrever o primeiro, que é o informativo.
  proc.on("error", (error) =>
    settle({ code: null, signal: null, error, leaked: false }),
  );

  proc.on("exit", (code, signal) => {
    const drain = setTimeout(() => {
      killLeftovers();
      settle({ code, signal, error: null, leaked: true });
    }, drainMs);
    // unref: um render que já terminou não pode segurar o event loop do servidor.
    drain.unref?.();

    proc.once("close", () => {
      clearTimeout(drain);
      settle({ code, signal, error: null, leaked: false });
    });
  });

  return { settled: () => settled };
}
