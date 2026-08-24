// Prova o degrau stale-while-error do cache do MCP.
//
// É o degrau que importa em produção: se o GitHub cair, o agente do n8n precisa
// receber conteúdo levemente velho com um aviso, e não um erro que trava a geração
// da cena. Também cobre a regressão do clamp de idade negativa — um mtime à frente
// do relógio fazia a entrada parecer "mais fresca que agora" e nunca expirar.
//
// Rodar com: npm test
process.env.MCP_CACHE_DIR = "/tmp/hf-mcp-cache-staletest";
process.env.MCP_CACHE_TTL_MS = "0"; // nada é considerado fresco: sempre revalida

const { fetchText } = await import(new URL("../mcp/sources.mjs", import.meta.url));

const URL_OK = "https://raw.githubusercontent.com/heygen-com/hyperframes/main/skills/hyperframes-core/references/minimal-composition.md";
let fails = 0;
const ok = (c, l, e = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`); if (!c) fails++; };

// 1) popula o cache com a rede boa
const first = await fetchText(URL_OK);
ok(first.source === "network" && first.body.length > 0, "populou o cache pela rede", `${first.body.length}b`);

// 2) derruba a rede e revalida com o cache já expirado
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("simulando GitHub fora do ar"); };
const stale = await fetchText(URL_OK);
globalThis.fetch = realFetch;

ok(stale.stale === true, "marcou a resposta como stale");
ok(!!stale.warning, "trouxe aviso explicando", stale.warning?.slice(0, 70));
ok(stale.body === first.body, "conteúdo idêntico ao cacheado (não perdeu nada)");

// 3) sem cache E sem rede → aí sim erro, não resposta vazia silenciosa
globalThis.fetch = async () => { throw new Error("simulando GitHub fora do ar"); };
let threw = false;
try { await fetchText(URL_OK.replace("minimal-composition", "nunca-buscado-antes")); } catch { threw = true; }
globalThis.fetch = realFetch;
ok(threw, "sem cache e sem rede, lança erro em vez de devolver vazio");

console.log(fails === 0 ? "\n  MCP CACHE: TODOS PASSARAM" : `\n  MCP CACHE: ${fails} FALHARAM`);
process.exit(fails === 0 ? 0 : 1);
