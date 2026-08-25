// Prova que todo módulo local importado pelo server.mjs é copiado para a imagem.
//
// Este teste existe por causa de um bug real: os três módulos das guardas de
// estabilidade (render-slots, job-retention, orphan-scan) foram mergeados sem
// entrar no COPY do Dockerfile. A imagem buildava sem um único aviso e o
// container entrava em restart loop com ERR_MODULE_NOT_FOUND — falha que só
// aparece no deploy, longe de quem escreveu o código.
//
// Import estático de topo não degrada: ou o arquivo está lá, ou o processo não
// sobe. Por isso a checagem é estática e não custa nada.
//
// Rodar com: npm test

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (f) => readFileSync(fileURLToPath(new URL(f, root)), "utf8");

let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};

const server = read("server.mjs");
const dockerfile = read("Dockerfile");

// Imports relativos de arquivo na raiz: `from "./algo.mjs"`. Subdiretórios
// (./mcp/...) ficam de fora porque são copiados como diretório inteiro.
const imports = [
  ...new Set(
    [...server.matchAll(/from\s+"\.\/([^"/]+\.(?:mjs|js))"/g)].map((m) => m[1]),
  ),
];
ok(
  imports.length > 0,
  `imports locais encontrados no server.mjs (${imports.length})`,
  imports.join(", "),
);

// Alvos das linhas COPY que caem na raiz do WORKDIR (terminam em "./").
const copiados = new Set();
for (const linha of dockerfile.split("\n")) {
  const m = linha.match(/^COPY\s+(.+?)\s+\.\/\s*$/);
  if (!m) continue;
  for (const arquivo of m[1].trim().split(/\s+/)) copiados.add(arquivo);
}
ok(
  copiados.size > 0,
  `arquivos copiados para a raiz da imagem (${copiados.size})`,
);

// A checagem que importa.
for (const arquivo of imports) {
  ok(
    copiados.has(arquivo),
    `${arquivo} é copiado para a imagem`,
    copiados.has(arquivo) ? "" : "→ container subiria em restart loop",
  );
}

// server.mjs é o entrypoint (CMD): sem ele nada existe.
ok(copiados.has("server.mjs"), "server.mjs é copiado para a imagem");

console.log(
  fails === 0
    ? "\n  DOCKERFILE COPY: TODOS PASSARAM"
    : `\n  DOCKERFILE COPY: ${fails} FALHARAM`,
);
process.exit(fails === 0 ? 0 : 1);
