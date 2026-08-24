// Regressão da busca do catálogo.
//
// A primeira versão exigia que TODAS as palavras da consulta casassem
// (`.every()`), o que zerava a busca inteira quando uma única palavra não
// aparecia: o agente do n8n pedia "cinematic transition effect" e recebia lista
// vazia, embora existissem 47 transições. Agora é ranqueamento por pontuação.
//
// Rodar com: npm test
process.env.MCP_CACHE_DIR = process.env.MCP_CACHE_DIR ?? "/tmp/hf-mcp-cache";

const { searchCatalog } = await import(new URL("../mcp/sources.mjs", import.meta.url));

let fails = 0;
const ok = (c, l, e = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`); if (!c) fails++; };

const base = await searchCatalog({ limit: 1 });
ok(base.total > 300, "catálogo carregou", `${base.total} itens`);

// Consultas descritivas, do jeito que um agente escreve. Nenhuma pode voltar vazia.
for (const [query, esperado] of [
  ["transition", "hw-scribble-transition"],
  ["cinematic transition", "cinematic-zoom"],
  ["text reveal animation", "morph-text"],
  ["lower third", "lower-third-bild"],
  ["scene transition effect", "transitions-blur"],
  ["karaoke captions", "caption-pill-karaoke"],
]) {
  const r = await searchCatalog({ query, limit: 3 });
  ok(r.total > 0, `"${query}" traz resultado`, `${r.total} itens, topo: ${r.items[0]?.name}`);
  ok(r.items[0]?.name === esperado, `"${query}" ranqueia ${esperado} no topo`, r.items[0]?.name);
}

// Plural na tag não pode zerar
const plural = await searchCatalog({ tag: "transitions", limit: 2 });
ok(plural.total > 0, "tag no plural casa com a tag singular", `${plural.total} itens`);

// Filtros continuam estritos
const comps = await searchCatalog({ query: "transition", type: "component", limit: 5 });
ok(comps.items.every((i) => i.type === "component"), "filtro de type é respeitado");

// Sem nenhuma palavra casando, aí sim vazio — não pode inventar resultado
const nada = await searchCatalog({ query: "qqzzxx wwvvkk", limit: 5 });
ok(nada.total === 0, "consulta sem nenhum casamento devolve vazio");

// Sem query, devolve tudo (paginado)
const tudo = await searchCatalog({ limit: 5 });
ok(tudo.total > 300 && tudo.items.length === 5, "sem query lista tudo, respeitando limit");

console.log(fails === 0 ? "\n  MCP SEARCH: TODOS PASSARAM" : `\n  MCP SEARCH: ${fails} FALHARAM`);
process.exit(fails === 0 ? 0 : 1);
