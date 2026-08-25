// Prova a guarda de concorrência do POST /render.
//
// O bloco de regressão vem primeiro: com MAX_CONCURRENT_RENDERS=0 a guarda tem que
// ser inerte, porque é esse o kill-switch — se ele não restaurar o comportamento
// antigo, não há rollback sem deploy.
//
// Rodar com: npm test

const { createRenderSlots } = await import(
  new URL("../render-slots.mjs", import.meta.url)
);

let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};

// ─── Regressão: max=0 desliga a guarda por completo ──────────────────────────
const desligado = createRenderSlots({ max: 0 });
let todosOk = true;
for (let i = 0; i < 50; i++) {
  if (!desligado.acquire().ok) todosOk = false;
}
ok(
  todosOk,
  "max=0 → nunca rejeita (kill-switch restaura o comportamento antigo)",
);
ok(desligado.inFlight() === 50, "max=0 → ainda conta os renders em voo");

// ─── Guarda com o default de 1 ───────────────────────────────────────────────
const slots = createRenderSlots({ max: 1 });

const primeiro = slots.acquire();
ok(primeiro.ok, "primeiro render → aceito");

const segundo = slots.acquire();
ok(!segundo.ok, "segundo render concorrente → rejeitado");
ok(
  segundo.inFlight === 1 && segundo.retryAfterS > 0,
  "rejeição carrega inFlight e retryAfterS para montar o 429",
  JSON.stringify(segundo),
);
ok(
  slots.inFlight() === 1,
  "rejeição NÃO incrementa o contador",
  `inFlight=${slots.inFlight()}`,
);

slots.release();
ok(slots.inFlight() === 0, "release devolve a vaga");
ok(slots.acquire().ok, "depois do release, novo render é aceito");

// ─── O piso em zero ──────────────────────────────────────────────────────────
// Um release a mais é bug, mas não pode virar vaga extra: se o contador ficasse
// negativo, dois renders passariam a caber onde só cabe um.
const piso = createRenderSlots({ max: 1 });
piso.acquire();
piso.release();
piso.release();
piso.release();
ok(piso.inFlight() === 0, "release extra não deixa o contador negativo");
ok(piso.acquire().ok, "após releases extras, exatamente uma vaga existe");
ok(!piso.acquire().ok, "após releases extras, a segunda vaga continua barrada");

// ─── Teto maior que 1 ────────────────────────────────────────────────────────
const dois = createRenderSlots({ max: 2 });
ok(dois.acquire().ok && dois.acquire().ok, "max=2 → dois renders cabem");
ok(!dois.acquire().ok, "max=2 → o terceiro é barrado");

console.log(
  fails === 0
    ? "\n  RENDER SLOTS: TODOS PASSARAM"
    : `\n  RENDER SLOTS: ${fails} FALHARAM`,
);
process.exit(fails === 0 ? 0 : 1);
