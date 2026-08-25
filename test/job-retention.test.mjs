// Prova a política de retenção dos diretórios de job.
//
// O bloco de regressão vem primeiro, e aqui ele é o que mais importa: até esta
// mudança NADA apagava um job. Uma varredura errada não deixa lixo — apaga o
// vídeo que alguém ia baixar, ou o diretório de um render em andamento. As duas
// proteções (job ativo, job recente) vêm antes de qualquer teste de expiração.
//
// Rodar com: npm test

const { shouldSweepJob, isJobDir } = await import(
  new URL("../job-retention.mjs", import.meta.url)
);

let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};

const H = 60 * 60 * 1000;
const cfg = { errorRetentionMs: 1 * H, doneRetentionMs: 24 * H };

// ─── Regressão: o que NUNCA pode ser varrido ─────────────────────────────────
ok(
  !shouldSweepJob({ ageMs: 999 * H, isActive: true }, cfg).sweep,
  "job com render em andamento nunca é varrido, por mais velho que seja",
);
ok(
  !shouldSweepJob({ hasError: true, ageMs: 999 * H, isActive: true }, cfg)
    .sweep,
  "job ativo não é varrido nem com error.txt presente",
);
ok(
  !shouldSweepJob({ ageMs: 5 * 60 * 1000 }, cfg).sweep,
  "job recém-criado (5 min, ainda processando) não é varrido",
);
ok(
  !shouldSweepJob({ hasDone: true, ageMs: 2 * H }, cfg).sweep,
  "job concluído com 2h continua disponível para download",
);

// ─── Expiração por erro: retenção curta ──────────────────────────────────────
ok(
  shouldSweepJob({ hasError: true, ageMs: 2 * H }, cfg).sweep,
  "job com erro e 2h → varrido",
);
ok(
  !shouldSweepJob({ hasError: true, ageMs: 30 * 60 * 1000 }, cfg).sweep,
  "job com erro e 30 min → preservado (janela de GET /logs)",
);

// ─── Expiração por conclusão: retenção longa ─────────────────────────────────
ok(
  shouldSweepJob({ hasDone: true, ageMs: 25 * H }, cfg).sweep,
  "job concluído e 25h → varrido",
);

// ─── O caso que hoje ninguém limpa ───────────────────────────────────────────
// Container reiniciado no meio de um render: o processo que escreveria error.txt
// morreu junto, então o diretório fica em "processing" para sempre.
const orfao = shouldSweepJob({ ageMs: 2 * H, isActive: false }, cfg);
ok(
  orfao.sweep && orfao.reason.includes("órfão"),
  "job sem done/error, sem processo vivo e com 2h → varrido como órfão",
  orfao.reason,
);

// ─── Precedência entre os flags ──────────────────────────────────────────────
// done.txt e error.txt juntos não deveriam existir, mas se existirem o erro manda:
// a retenção curta é a conservadora em disco, e um job com erro não tem vídeo bom.
ok(
  shouldSweepJob({ hasDone: true, hasError: true, ageMs: 2 * H }, cfg).sweep,
  "done + error juntos → decide pelo erro (retenção curta)",
);

// ─── Diretórios que a varredura não pode tocar ───────────────────────────────
ok(!isJobDir("lint-abc"), "lint-* fica fora da varredura");
ok(!isJobDir("check-abc"), "check-* fica fora da varredura");
ok(
  isJobDir("550e8400-e29b-41d4-a716-446655440000"),
  "diretório de job normal entra na varredura",
);

console.log(
  fails === 0
    ? "\n  JOB RETENTION: TODOS PASSARAM"
    : `\n  JOB RETENTION: ${fails} FALHARAM`,
);
process.exit(fails === 0 ? 0 : 1);
