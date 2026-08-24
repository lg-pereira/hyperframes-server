// Fontes de conteúdo do MCP de autoria: catálogo do registry e docs de contrato.
//
// Tudo vem do repo upstream heygen-com/hyperframes. O pacote npm NÃO traz as skills
// boas — `dist/skills` só tem `hyperframes` e `hyperframes-cli`, e `dist/docs` são
// ~7.8KB de conteúdo fino. Os docs que realmente descrevem o contrato
// (data-attributes, determinism-rules, sub-compositions...) vivem em `skills/` no
// GitHub. Por isso o cache remoto aqui é obrigatório, não otimização.

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

const RAW_BASE = "https://raw.githubusercontent.com/heygen-com/hyperframes/main";
const REGISTRY_BASE = `${RAW_BASE}/registry`;
const SKILLS_BASE = `${RAW_BASE}/skills`;

export const CACHE_DIR = process.env.MCP_CACHE_DIR ?? "/tmp/hf-mcp-cache";

// Mesmo TTL que o CLI do hyperframes usa para o próprio cache de registry.
const CACHE_TTL_MS = parseInt(process.env.MCP_CACHE_TTL_MS ?? String(24 * 60 * 60 * 1000));
const FETCH_TIMEOUT_MS = 10_000;

const ITEM_DIR = { block: "blocks", component: "components" };

// Um arquivo de cache por URL. O nome é derivado da URL para não depender de hash.
function cachePathFor(url) {
  const safe = url.replace(RAW_BASE + "/", "").replace(/[^A-Za-z0-9._-]/g, "__");
  return join(CACHE_DIR, safe);
}

async function readCache(file) {
  try {
    const [info, body] = await Promise.all([stat(file), readFile(file, "utf8")]);
    // Clamp em 0: se o mtime ficar à frente do relógio (skew de filesystem, NFS,
    // container com hora diferente), a idade sairia negativa e a entrada passaria
    // a ser "mais fresca que agora" — nunca expiraria.
    return { body, ageMs: Math.max(0, Date.now() - info.mtimeMs) };
  } catch {
    return null;
  }
}

async function writeCache(file, body) {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, body, "utf8");
  } catch {
    // cache é otimização — falha ao gravar não pode derrubar a resposta
  }
}

/**
 * Busca um recurso de texto do repo upstream, com cache em disco.
 *
 * Ordem: cache fresco → rede → cache velho (stale-while-error). O último degrau é o
 * que importa em produção: se o GitHub cair, o agente recebe conteúdo levemente
 * velho com um aviso, em vez de um erro que trava a geração da cena.
 */
export async function fetchText(url, { force = false } = {}) {
  const file = cachePathFor(url);
  const cached = await readCache(file);

  if (!force && cached && cached.ageMs < CACHE_TTL_MS) {
    return { body: cached.body, source: "cache", stale: false };
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    await writeCache(file, body);
    return { body, source: "network", stale: false };
  } catch (err) {
    if (cached) {
      return {
        body: cached.body,
        source: "cache",
        stale: true,
        warning:
          `Não foi possível atualizar de ${url} (${err.message}). ` +
          `Servindo cópia em cache de ${Math.round(cached.ageMs / 3_600_000)}h atrás.`,
      };
    }
    throw new Error(`Falha ao buscar ${url}: ${err.message}`);
  }
}

async function fetchJson(url, opts) {
  const out = await fetchText(url, opts);
  try {
    return { ...out, json: JSON.parse(out.body) };
  } catch (err) {
    throw new Error(`Resposta de ${url} não é JSON válido: ${err.message}`);
  }
}

// ─── Catálogo ────────────────────────────────────────────────────────────────

// O registry.json é um índice FINO: só `name` e `type`, com o tipo prefixado
// ("hyperframes:block"). Tags, título, descrição, dimensões e duração vivem no
// registry-item.json de cada item — é por isso que montar um catálogo pesquisável
// exige hidratar os ~372 itens, exatamente como o `hyperframes catalog` faz.
const HYDRATE_CONCURRENCY = 12;

function normalizeType(type) {
  return String(type ?? "").replace(/^hyperframes:/, "");
}

/** Índice fino do registry + a revisão do catálogo upstream. */
export async function getRegistryManifest(opts) {
  const { json, ...meta } = await fetchJson(`${REGISTRY_BASE}/registry.json`, opts);
  const entries = (json.items ?? [])
    .map((e) => ({ name: e.name, type: normalizeType(e.type) }))
    // "example" não é instalável nem útil para o agente — o CLI também descarta.
    .filter((e) => e.type === "block" || e.type === "component");
  return { entries, revision: json.catalogArtifact?.revision ?? "unknown", ...meta };
}

async function mapWithConcurrency(list, limit, fn) {
  const out = new Array(list.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (cursor < list.length) {
        const i = cursor++;
        out[i] = await fn(list[i]);
      }
    }),
  );
  return out;
}

/**
 * Catálogo completo e pesquisável, com os metadados de cada item.
 *
 * Hidratar 372 itens é caro, então o resultado agregado é cacheado num arquivo só,
 * chaveado pela `catalogArtifact.revision` do upstream — quando a HeyGen publica
 * itens novos a revisão muda e o cache invalida sozinho, sem TTL adivinhado.
 * `scripts/warm-mcp-cache.mjs` paga esse custo no build da imagem.
 */
export async function getCatalogIndex() {
  const { entries, revision } = await getRegistryManifest();
  const aggregate = join(CACHE_DIR, `catalog-index-${revision}.json`);

  const cached = await readCache(aggregate);
  if (cached) {
    try {
      return { items: JSON.parse(cached.body), revision };
    } catch {
      // agregado corrompido — recai na hidratação abaixo
    }
  }

  const hydrated = await mapWithConcurrency(entries, HYDRATE_CONCURRENCY, async (entry) => {
    try {
      const dir = ITEM_DIR[entry.type];
      const { json } = await fetchJson(`${REGISTRY_BASE}/${dir}/${entry.name}/registry-item.json`);
      return {
        name: entry.name,
        type: entry.type,
        title: json.title ?? entry.name,
        description: json.description ?? "",
        tags: json.tags ?? [],
        dimensions: json.dimensions,
        duration: json.duration,
      };
    } catch {
      // Um item quebrado no upstream não pode zerar o catálogo inteiro:
      // entra sem metadados e ainda é encontrável pelo nome.
      return { name: entry.name, type: entry.type, title: entry.name, description: "", tags: [] };
    }
  });

  await writeCache(aggregate, JSON.stringify(hydrated));
  return { items: hydrated, revision };
}

/**
 * Busca no catálogo por texto livre, tipo e tag. Sem modelo semântico: casa
 * substring em name/title/description/tags, que é suficiente e não depende de rede
 * extra nem de download de modelo.
 */
export async function searchCatalog({ query, type, tag, limit = 20 } = {}) {
  const { items, ...meta } = await getCatalogIndex();
  const q = query?.trim().toLowerCase();
  const t = tag?.trim().toLowerCase();

  const matched = items.filter((item) => {
    if (type && item.type !== type) return false;
    if (t && !(item.tags ?? []).some((x) => String(x).toLowerCase() === t)) return false;
    if (!q) return true;
    const hay = [item.name, item.title, item.description, ...(item.tags ?? [])]
      .join(" ")
      .toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  });

  return { total: matched.length, items: matched.slice(0, limit), ...meta };
}

/** Todas as tags do catálogo com contagem — ajuda o agente a descobrir o que existe. */
export async function listTags({ type } = {}) {
  const { items } = await getCatalogIndex();
  const counts = new Map();
  for (const item of items) {
    if (type && item.type !== type) continue;
    for (const tag of item.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

// Sem `type` informado, descobre pelo manifesto — o agente raramente sabe se um
// nome é block ou component, e errar isso daria um 404 confuso.
async function resolveItemType(name, type) {
  if (type) return type;
  const { entries } = await getRegistryManifest();
  const found = entries.find((i) => i.name === name);
  if (!found) {
    throw new Error(
      `Item "${name}" não existe no catálogo. Use search_catalog para encontrar o nome exato.`,
    );
  }
  return found.type;
}

/** Manifesto de um item: metadados, variables[] tipadas e a lista de arquivos. */
export async function getCatalogItem(name, type) {
  const resolved = normalizeType(await resolveItemType(name, type));
  const dir = ITEM_DIR[resolved];
  if (!dir) throw new Error(`Tipo inválido: "${resolved}" (use "block" ou "component")`);

  const { json, ...meta } = await fetchJson(`${REGISTRY_BASE}/${dir}/${name}/registry-item.json`);

  // TEMPLATE.md é o contrato de edição em prosa ("Editable slots" / "Protected").
  // Nem todo item tem — ausência não é erro.
  let templateDoc = null;
  if ((json.files ?? []).some((f) => f.path === "TEMPLATE.md")) {
    try {
      templateDoc = (await fetchText(`${REGISTRY_BASE}/${dir}/${name}/TEMPLATE.md`)).body;
    } catch {
      templateDoc = null;
    }
  }

  return { item: json, itemType: resolved, templateDoc, ...meta };
}

/** Código-fonte de um arquivo do item. Sem `path`, pega o primeiro arquivo não-doc. */
export async function getCatalogItemSource(name, type, path) {
  const { item, itemType, ...meta } = await getCatalogItem(name, type);
  const files = item.files ?? [];

  const target =
    path ??
    files.find((f) => f.path.endsWith(".html"))?.path ??
    files.find((f) => f.path !== "TEMPLATE.md")?.path;

  if (!target) throw new Error(`Item "${name}" não declara nenhum arquivo de código.`);
  if (!files.some((f) => f.path === target)) {
    throw new Error(
      `Arquivo "${target}" não pertence a "${name}". Disponíveis: ${files.map((f) => f.path).join(", ")}`,
    );
  }
  // Defesa em profundidade: `target` vem do manifesto remoto, mas é concatenado numa URL.
  if (/(^|[/\\])\.\.([/\\]|$)/.test(target)) {
    throw new Error(`Caminho inseguro: "${target}"`);
  }

  const out = await fetchText(`${REGISTRY_BASE}/${ITEM_DIR[itemType]}/${name}/${target}`);
  return { path: target, availableFiles: files.map((f) => f.path), ...meta, ...out };
}

// ─── Contrato e referências ──────────────────────────────────────────────────

// Mapa de tópico → arquivo no repo upstream. Os nomes de tópico são os que o agente
// vê no enum da tool, então são curtos e descritivos.
const REFERENCES = {
  "data-attributes": "hyperframes-core/references/data-attributes.md",
  "determinism-rules": "hyperframes-core/references/determinism-rules.md",
  "tracks-and-clips": "hyperframes-core/references/tracks-and-clips.md",
  "sub-compositions": "hyperframes-core/references/sub-compositions.md",
  "variables-and-media": "hyperframes-core/references/variables-and-media.md",
  "composition-patterns": "hyperframes-core/references/composition-patterns.md",
  "minimal-composition": "hyperframes-core/references/minimal-composition.md",
  "full-screen-motion": "hyperframes-core/references/full-screen-motion.md",
  animation: "hyperframes-animation/SKILL.md",
};

export const REFERENCE_TOPICS = Object.keys(REFERENCES);

export async function getReference(topic) {
  const path = REFERENCES[topic];
  if (!path) {
    throw new Error(
      `Tópico desconhecido: "${topic}". Disponíveis: ${REFERENCE_TOPICS.join(", ")}`,
    );
  }
  return fetchText(`${SKILLS_BASE}/${path}`);
}

/** O contrato de composição — SKILL.md do hyperframes-core. */
export async function getCompositionContract() {
  return fetchText(`${SKILLS_BASE}/hyperframes-core/SKILL.md`);
}

/** Docs que o warm-up do build pré-carrega (o catálogo tem caminho próprio). */
export function warmupTargets() {
  return [
    `${SKILLS_BASE}/hyperframes-core/SKILL.md`,
    ...Object.values(REFERENCES).map((p) => `${SKILLS_BASE}/${p}`),
  ];
}
