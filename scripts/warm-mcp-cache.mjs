#!/usr/bin/env node
// Pré-aquece o cache do MCP no build da imagem.
//
// Sem isso, a primeira chamada do agente paga a hidratação dos ~372 itens do
// catálogo (~6s) e cada doc de contrato vem da rede. Com o warm-up, a primeira
// chamada em produção já responde em dezenas de ms.
//
// NUNCA falha o build: uma imagem sem rede (ou o GitHub fora do ar no momento do
// build) ainda deve gerar um container funcional — o runtime busca sob demanda e
// o degrau stale-while-error cobre o resto.

import { getCatalogIndex, getCompositionContract, fetchText, warmupTargets, CACHE_DIR } from "../mcp/sources.mjs";

const started = Date.now();
let ok = 0;
let failed = 0;

async function step(label, fn) {
  try {
    const out = await fn();
    ok++;
    console.log(`  ✓ ${label}${out ? ` — ${out}` : ""}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${label} — ${err.message}`);
  }
}

console.log(`Aquecendo o cache do MCP em ${CACHE_DIR}`);

await step("contrato de composição", async () => {
  const { body } = await getCompositionContract();
  return `${body.length} bytes`;
});

for (const url of warmupTargets()) {
  const name = url.split("/").pop();
  await step(`referência ${name}`, async () => `${(await fetchText(url)).body.length} bytes`);
}

await step("índice do catálogo (hidrata todos os itens)", async () => {
  const { items, revision } = await getCatalogIndex();
  return `${items.length} itens, revisão ${revision.slice(0, 12)}`;
});

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`Cache aquecido em ${secs}s — ${ok} ok, ${failed} falharam`);
if (failed > 0) {
  console.log("Falhas no aquecimento não quebram o build: o runtime busca sob demanda.");
}
process.exit(0);
