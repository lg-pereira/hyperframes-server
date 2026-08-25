// Prova o freio contra o CLI que falha e não sai.
//
// O caso real, medido na VPS: `hyperframes render` imprime "✗ Render failed" aos
// 12,5s e fica vivo. Sem `exit`, o desfecho pelo exit nunca chega, e o job ficou
// em `processing` por 231s no teste instrumentado — sem nenhum sinal de parar,
// até o RENDER_TIMEOUT_MS de 1800s. Com MAX_CONCURRENT_RENDERS=1, é o endpoint
// inteiro em 429 durante todo esse tempo.
//
// O bloco de regressão vem primeiro: idleMs=0 tem que deixar o watchdog inerte,
// porque é esse o kill-switch. Se ele não restaurar o comportamento anterior,
// não há rollback sem deploy.
//
// Rodar com: npm test

const { createIdleWatchdog, DEFAULT_IDLE_MS } = await import(
  new URL("../idle-watchdog.mjs", import.meta.url)
);

let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Regressão: idleMs=0 desliga o freio por completo ────────────────────────
let matouDesligado = false;
const desligado = createIdleWatchdog({
  idleMs: 0,
  onIdle: () => (matouDesligado = true),
});
desligado.touch();
await espera(120);
ok(!matouDesligado, "idleMs=0 → nunca dispara (kill-switch)");
ok(!desligado.armed(), "idleMs=0 → nem arma o timer");

// ─── Silêncio prolongado → dispara ───────────────────────────────────────────
let matou = 0;
const calado = createIdleWatchdog({ idleMs: 60, onIdle: () => matou++ });
calado.touch();
await espera(200);
ok(matou === 1, "silêncio além da janela → dispara", `disparou ${matou}x`);
ok(calado.fired(), "silêncio além da janela → fica marcado como disparado");

// ─── Saída contínua → NUNCA dispara ──────────────────────────────────────────
// A garantia que protege um render legítimo: enquanto o CLI fala, o freio não
// encosta nele. Matar um render que está trabalhando seria pior que o bug.
let matouFalante = false;
const falante = createIdleWatchdog({
  idleMs: 100,
  onIdle: () => (matouFalante = true),
});
falante.touch();
for (let i = 0; i < 10; i++) {
  await espera(30);
  falante.touch(); // chunk de stdout chegando
}
ok(!matouFalante, "saída a cada 30ms com janela de 100ms → não dispara");
ok(falante.armed(), "render falante → watchdog segue armado");

// ─── stop() no desfecho desarma ──────────────────────────────────────────────
let matouParado = false;
const parado = createIdleWatchdog({
  idleMs: 60,
  onIdle: () => (matouParado = true),
});
parado.touch();
parado.stop();
await espera(150);
ok(!matouParado, "stop() antes da janela → não dispara");
ok(!parado.armed(), "stop() → desarma");

// ─── Dispara no máximo uma vez ───────────────────────────────────────────────
// Um segundo disparo mandaria SIGTERM para um grupo que já morreu — e, pior,
// sobrescreveria o desfecho já escrito.
let vezes = 0;
const umaVez = createIdleWatchdog({ idleMs: 40, onIdle: () => vezes++ });
umaVez.touch();
await espera(120);
umaVez.touch();
await espera(120);
ok(vezes === 1, "dispara no máximo uma vez", `disparou ${vezes}x`);

// ─── Default generoso ────────────────────────────────────────────────────────
// O default erra para o lado de não matar: aperta-se depois de observar quanto
// tempo os renders reais passam calados, nunca antes.
ok(
  DEFAULT_IDLE_MS >= 5 * 60 * 1000,
  "default de pelo menos 5 min",
  `${DEFAULT_IDLE_MS}ms`,
);

console.log(
  fails === 0 ? "\nIDLE WATCHDOG: OK" : `\nIDLE WATCHDOG: ${fails} FALHA(S)`,
);
process.exit(fails === 0 ? 0 : 1);
