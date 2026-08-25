// Guarda de concorrência do POST /render.
//
// Sem ela, cada requisição sobe um processo na hora: dois renders simultâneos com
// RENDER_WORKERS=4 são 8 Chromiums disputando os mesmos cores e o mesmo shm. O
// resultado não é "dois renders mais lentos", é os dois estourando o timeout.
//
// A política é rejeitar, não enfileirar: nada fica pendurado em memória para se
// perder num restart, e quem chama (n8n) já sabe reagir a 429 com retry.
//
// Vive fora do server.mjs porque importar aquele arquivo sobe o servidor — aqui
// não há I/O nem dependência de Fastify, então dá para testar em unidade.

// Estimativa de espera devolvida no Retry-After. Não é uma promessa: é o tempo
// que um render típico ainda pode levar. Curto demais faz o cliente martelar;
// longo demais atrasa o próximo job sem motivo.
const DEFAULT_RETRY_AFTER_S = 30;

// max = 0 desliga a guarda por completo (comportamento anterior a esta função:
// nenhum teto, todo POST spawna). É o kill-switch, via MAX_CONCURRENT_RENDERS=0.
export function createRenderSlots({
  max = 1,
  retryAfterS = DEFAULT_RETRY_AFTER_S,
} = {}) {
  let inFlight = 0;

  return {
    // { ok: true } quando há vaga. { ok: false, inFlight, retryAfterS } quando não —
    // o handler traduz isso em 429 sem ter criado nenhum diretório de job.
    acquire() {
      if (max > 0 && inFlight >= max) {
        return { ok: false, inFlight, retryAfterS };
      }
      inFlight++;
      return { ok: true, inFlight };
    },

    // Precisa rodar em TODOS os desfechos do render (sucesso, exit != 0, timeout,
    // falha de disco antes do spawn). Um release perdido tranca o servidor até o
    // próximo restart, que é pior do que não ter guarda nenhuma — por isso o piso
    // em zero: um release a mais é bug, mas não pode virar vaga extra.
    release() {
      if (inFlight > 0) inFlight--;
      return inFlight;
    },

    inFlight: () => inFlight,
    max: () => max,
  };
}
