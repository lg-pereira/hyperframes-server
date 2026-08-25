// Freio para o CLI que termina o trabalho e não sai.
//
// O `settleOnExit` cobre o filho que SAI deixando neto segurando os pipes. Não
// cobre o caso que realmente prendia o render aqui: o CLI do hyperframes imprime
// "✗ Render failed", e então simplesmente não sai. Fica vivo com o browser e o
// file server abertos, o event loop dele nunca esvazia, e não há `exit` para
// concluir o job. Medido na VPS: erro do CLI aos 12,5s, job em `processing` aos
// 231s e ainda contando — o único freio era o RENDER_TIMEOUT_MS de 1800s, com o
// mutex de um render por vez devolvendo 429 para todo o resto nesse intervalo.
//
// O sinal usado aqui é a AUSÊNCIA de saída. Um render vivo fala: barra de
// progresso, linhas de trace, log dos workers. Um CLI que já desistiu fica em
// silêncio absoluto para sempre. Silêncio longo + processo vivo = acabou, e
// quem mata é o servidor.
//
// Cuidado que define o default: matar um render QUE ESTÁ TRABALHANDO é pior do
// que o bug. Por isso a janela é generosa (5 min) e configurável — aperte depois
// de observar quanto tempo os seus renders reais passam calados, não antes.
// idleMs = 0 desliga por completo.

export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// `touch()` a cada chunk de stdout/stderr; `stop()` no desfecho do job.
// `onIdle` roda no máximo uma vez.
export function createIdleWatchdog({ idleMs = DEFAULT_IDLE_MS, onIdle } = {}) {
  let timer = null;
  let fired = false;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const touch = () => {
    if (idleMs <= 0 || fired) return;
    stop();
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      onIdle();
    }, idleMs);
    // unref: o watchdog não pode segurar o event loop do servidor sozinho.
    timer.unref?.();
  };

  return {
    touch,
    stop,
    fired: () => fired,
    armed: () => timer !== null,
    idleMs: () => idleMs,
  };
}
