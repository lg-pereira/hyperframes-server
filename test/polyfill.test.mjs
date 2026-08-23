// Verifica studio-polyfill.js contra a implementação nativa do Node.
//
// O polyfill reimplementa SHA-256 na mão. Um hash errado não daria erro visível:
// a Studio simplesmente calcularia uma versão de arquivo que não bate com a do
// servidor e todo save morreria em 409 de conflito. Por isso o teste compara com
// node:crypto nos casos de borda do padding (0/55/56/63/64/65 bytes), em UTF-8
// multibyte e num payload grande.
//
// Rodar com: npm test
import { readFileSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(root + "studio-polyfill.js", "utf8");

// Ambiente falso de "contexto inseguro": getRandomValues existe, randomUUID e subtle não.
const fakeCrypto = { getRandomValues: (a) => webcrypto.getRandomValues(a) };
const sandbox = {
  window: {},
  navigator: {},
  document: undefined,
  Uint8Array, Uint32Array, ArrayBuffer, Promise, Object, Math, String, Number, TypeError, Error,
};
sandbox.globalThis = sandbox;
sandbox.crypto = fakeCrypto;
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

// ── SHA-256 vs Node ────────────────────────────────────────────────────────
ok(!!sandbox.crypto.subtle, "crypto.subtle foi definido");

const cases = [
  "",
  "abc",
  "a".repeat(55),   // borda: exatamente antes de precisar de bloco extra
  "a".repeat(56),   // borda: força um bloco de padding adicional
  "a".repeat(63),
  "a".repeat(64),   // borda: bloco exato
  "a".repeat(65),
  "a".repeat(1000),
  "<div data-width=\"1920\">Olá! ção 日本語 🎬</div>",  // UTF-8 multibyte
  readFileSync(root + "server.mjs", "utf8").slice(0, 50000),   // payload realista grande
];

for (const [i, text] of cases.entries()) {
  const bytes = new TextEncoder().encode(text);
  const digest = await sandbox.crypto.subtle.digest("SHA-256", bytes);
  const got = Buffer.from(digest).toString("hex");
  const want = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  ok(got === want, `sha256 caso ${i} (len=${bytes.length})`, got === want ? "" : `\n  got=${got}\n want=${want}`);
}

// Formato exato que a Studio monta em studioFileContentVersion()
const html = "<html>editado</html>";
const d = await sandbox.crypto.subtle.digest("SHA-256", new TextEncoder().encode(html));
const hex = Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
ok(`"sha256:${hex}"` === `"sha256:${createHash("sha256").update(html).digest("hex")}"`, "ETag no formato da Studio");

// Aceita ArrayBuffer e objeto {name}
const ab = new TextEncoder().encode("abc").buffer;
ok(Buffer.from(await sandbox.crypto.subtle.digest("SHA-256", ab)).toString("hex")
   === createHash("sha256").update("abc").digest("hex"), "aceita ArrayBuffer");
ok(Buffer.from(await sandbox.crypto.subtle.digest({ name: "sha-256" }, new TextEncoder().encode("abc"))).toString("hex")
   === createHash("sha256").update("abc").digest("hex"), "aceita {name} e é case-insensitive");

// Algoritmo não suportado deve rejeitar, não devolver lixo
let rejected = false;
try { await sandbox.crypto.subtle.digest("SHA-512", new Uint8Array([1])); } catch { rejected = true; }
ok(rejected, "SHA-512 rejeita em vez de mascarar");

// ── randomUUID ─────────────────────────────────────────────────────────────
const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuids = new Set();
let badFormat = 0;
for (let i = 0; i < 20000; i++) {
  const u = sandbox.crypto.randomUUID();
  if (!RE.test(u)) badFormat++;
  uuids.add(u);
}
ok(badFormat === 0, "randomUUID: formato v4 RFC 4122", `amostras inválidas=${badFormat}`);
ok(uuids.size === 20000, "randomUUID: sem colisões em 20k", `únicos=${uuids.size}`);

// ── no-op em secure context ────────────────────────────────────────────────
const native = { randomUUID: () => "NATIVO", subtle: { marker: "NATIVO" }, getRandomValues: (a) => webcrypto.getRandomValues(a) };
const s2 = { window: {}, navigator: { clipboard: { marker: "NATIVO" } }, Uint8Array, Uint32Array, ArrayBuffer, Promise, Object, Math, String, Number, TypeError, Error };
s2.globalThis = s2; s2.crypto = native;
vm.createContext(s2); vm.runInContext(src, s2);
ok(s2.crypto.randomUUID() === "NATIVO", "no-op: randomUUID nativo preservado");
ok(s2.crypto.subtle.marker === "NATIVO", "no-op: subtle nativo preservado");
ok(s2.navigator.clipboard.marker === "NATIVO", "no-op: clipboard nativo preservado");

console.log(fails === 0 ? "\nTODOS OS TESTES PASSARAM" : `\n${fails} TESTE(S) FALHARAM`);
process.exit(fails === 0 ? 0 : 1);
