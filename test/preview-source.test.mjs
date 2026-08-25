// Prova a decisão de fonte do POST /preview: html (comportamento de sempre) vs
// preview_id (reabrir a Studio sobre um diretório já em disco).
//
// O bloco de regressão vem primeiro: o caminho `html` é o caminho de sempre e
// não pode mudar de forma por causa da reabertura. Depois vêm as
// guardas do caminho novo — em especial o preview_id fora do formato UUID, que é
// o que impede um id do cliente de virar path traversal no PREVIEW_DIR.
//
// Rodar com: npm test

const { resolvePreviewSource, UUID_RE } = await import(
  new URL("../preview-source.mjs", import.meta.url)
);

const ID = "550e8400-e29b-41d4-a716-446655440000";
let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};

// ─── Regressão: o caminho html continua exatamente como era ──────────────────
const onlyHtml = resolvePreviewSource({ html: "<div></div>" });
ok(onlyHtml.ok && onlyHtml.mode === "html", "só html → cria preview novo");

const htmlComExtras = resolvePreviewSource({
  html: "<div></div>",
  hasExtras: true,
});
ok(
  htmlComExtras.ok && htmlComExtras.mode === "html",
  "html + compositions/assets → cria preview novo",
);

const semNada = resolvePreviewSource({});
ok(!semNada.ok && semNada.status === 400, "corpo vazio → 400", semNada.error);

// ─── Reabertura ───────────────────────────────────────────────────────────────
const reuse = resolvePreviewSource({ previewId: ID, previewDirExists: true });
ok(reuse.ok && reuse.mode === "reuse", "preview_id com diretório em disco → reuso");

const semDir = resolvePreviewSource({ previewId: ID, previewDirExists: false });
ok(
  !semDir.ok && semDir.status === 404,
  "preview_id sem diretório (expirado) → 404",
  semDir.error,
);

const ambos = resolvePreviewSource({ html: "<div></div>", previewId: ID });
ok(
  !ambos.ok && ambos.status === 400,
  "html + preview_id → 400 (mutuamente exclusivos)",
);

const comExtras = resolvePreviewSource({
  previewId: ID,
  previewDirExists: true,
  hasExtras: true,
});
ok(
  !comExtras.ok && comExtras.status === 400,
  "preview_id + assets → 400 em vez de ignorar em silêncio",
);

// ─── Traversal: o id do cliente é concatenado num path ────────────────────────
for (const bad of [
  "../../etc/passwd",
  "/etc/passwd",
  `${ID}/../../etc`,
  "nao-e-uuid",
  `${ID}extra`,
]) {
  const res = resolvePreviewSource({ previewId: bad, previewDirExists: true });
  ok(
    !res.ok && res.status === 400,
    `preview_id inválido rejeitado: ${JSON.stringify(bad)}`,
  );
  ok(!UUID_RE.test(bad), `  e não passa no UUID_RE: ${JSON.stringify(bad)}`);
}

// ─── Kill-switch ──────────────────────────────────────────────────────────────
const desligado = resolvePreviewSource({
  previewId: ID,
  previewDirExists: true,
  reopenEnabled: false,
});
ok(
  !desligado.ok && desligado.status === 400,
  "PREVIEW_REOPEN=false → preview_id recusado",
  desligado.error,
);
const htmlDesligado = resolvePreviewSource({
  html: "<div></div>",
  reopenEnabled: false,
});
ok(
  htmlDesligado.ok && htmlDesligado.mode === "html",
  "PREVIEW_REOPEN=false → caminho html segue intacto",
);

console.log(
  fails === 0
    ? "\n  PREVIEW SOURCE: TODOS PASSARAM"
    : `\n  PREVIEW SOURCE: ${fails} FALHARAM`,
);
process.exit(fails === 0 ? 0 : 1);
