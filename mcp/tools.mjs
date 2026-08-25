// As tools que o agente de IA enxerga.
//
// As `description` aqui não são documentação para humanos: são o texto que o modelo
// lê para decidir qual tool chamar e quando. Por isso ficam em inglês (a língua em
// que os modelos foram treinados para tool-calling), são explícitas sobre a ordem de
// uso, e get_composition_contract se declara pré-requisito das demais.

import { z } from "zod";
import {
  searchCatalog,
  listTags,
  getCatalogItem,
  getCatalogItemSource,
  getReference,
  getCompositionContract,
  REFERENCE_TOPICS,
} from "./sources.mjs";

// O retorno vai direto para o contexto do agente. Sem teto, um único
// get_catalog_item_source de 34KB já compete com o resto do prompt.
const MAX_SOURCE_BYTES = parseInt(process.env.MCP_MAX_SOURCE_BYTES ?? "40000");

function truncate(text, max = MAX_SOURCE_BYTES) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { text, truncated: false, bytes };
  // Corta por bytes, não por caracteres, para o teto valer de verdade em UTF-8.
  const cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  return {
    text:
      cut +
      `\n\n<!-- [TRUNCADO] Mostrando ${max} de ${bytes} bytes. ` +
      `Peça um arquivo específico via "path" para ver outra parte. -->`,
    truncated: true,
    bytes,
  };
}

// Todo retorno de tool é texto — é o formato que os clientes MCP tratam de forma
// mais previsível, e o agente lê JSON em texto sem dificuldade.
const text = (value) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
});

// Uma falha de tool não pode derrubar a execução do agente: ela volta como conteúdo
// de erro para que o modelo possa corrigir a chamada e tentar de novo.
const fail = (err) => ({
  content: [{ type: "text", text: `ERRO: ${err.message}` }],
  isError: true,
});

const withWarning = (payload, meta) =>
  meta?.warning ? { ...payload, _warning: meta.warning } : payload;

export function registerTools(server) {
  server.registerTool(
    "get_composition_contract",
    {
      title: "Get the HyperFrames composition contract",
      description:
        "READ THIS FIRST, before writing or editing any HyperFrames composition HTML. " +
        "Returns the authoring contract: required root attributes (data-composition-id, " +
        "data-start, data-duration, data-width, data-height), the class=\"clip\" visibility " +
        "marker, track rules, the single paused GSAP timeline registered on " +
        "window.__timelines, and the non-negotiable determinism rules. Compositions written " +
        "without reading this fail lint or render incorrectly.",
      inputSchema: {},
    },
    async () => {
      try {
        const out = await getCompositionContract();
        return text(out.warning ? `${out.body}\n\n<!-- ${out.warning} -->` : out.body);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_reference",
    {
      title: "Get a HyperFrames reference document",
      description:
        "Fetch one detailed reference document about a specific HyperFrames topic. Use after " +
        "get_composition_contract when you need depth on one area: 'data-attributes' for the " +
        "full attribute table, 'determinism-rules' for what breaks seek-based rendering, " +
        "'tracks-and-clips' for timing and overlap rules, 'sub-compositions' for splitting a " +
        "composition across files with data-composition-src, 'variables-and-media' for video/" +
        "audio placement and variables, 'minimal-composition' for the smallest working " +
        "skeleton, 'animation' for GSAP motion patterns.",
      inputSchema: {
        topic: z.enum(REFERENCE_TOPICS).describe("Which reference document to fetch"),
      },
    },
    async ({ topic }) => {
      try {
        const out = await getReference(topic);
        return text(out.warning ? `${out.body}\n\n<!-- ${out.warning} -->` : out.body);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "search_catalog",
    {
      title: "Search the HyperFrames template catalog",
      description:
        "Search the catalog of ready-made HyperFrames templates: 154 blocks (complete, " +
        "self-contained scenes) and 218 components (snippets and motion primitives to drop " +
        "into a scene). Use this to find transitions, text effects, overlays, lower thirds, " +
        "caption styles and other motion pieces instead of writing animation from scratch. " +
        "Useful tags: transition, motion-primitive, caption-style, overlay, text-effect, " +
        "reveal, lower-third, typography, background, social. Call list_catalog_tags to see " +
        "everything available. Returns metadata only — call get_catalog_item next for the " +
        "editable variables, and get_catalog_item_source for the actual code.\n\n" +
        "SEARCH TIPS: the catalog is indexed in English over name, title, description and " +
        "tags. Prefer SHORT keywords ('transition', 'text reveal', 'lower third') over full " +
        "sentences — results are ranked, so extra words dilute rather than sharpen the match. " +
        "When you know the category, `tag` is more precise than `query`.",
      inputSchema: {
        query: z.string().optional().describe("Free-text search over name, title, description and tags"),
        type: z.enum(["block", "component"]).optional().describe("Restrict to blocks or components"),
        tag: z.string().optional().describe("Exact tag match, e.g. 'transition'"),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, type, tag, limit }) => {
      try {
        const out = await searchCatalog({ query, type, tag, limit });
        const payload = {
          total_matches: out.total,
          showing: out.items.length,
          items: out.items.map((i) => ({
            name: i.name,
            type: i.type,
            title: i.title,
            description: i.description,
            tags: i.tags,
            dimensions: i.dimensions,
            duration: i.duration,
          })),
        };

        // Lista vazia sem explicação faz o agente repetir a mesma busca ou
        // desistir do catálogo. Devolver as tags mais populares dá a ele o
        // vocabulário real para tentar de novo com sentido.
        if (out.total === 0) {
          payload.hint =
            "Nenhum resultado. O catálogo é em inglês e indexa nome, título, descrição e tags. " +
            "Tente uma palavra-chave mais curta (ex: 'transition' em vez de 'scene transition effect'), " +
            "ou filtre por uma das tags abaixo.";
          payload.available_tags = (await listTags({ type })).slice(0, 40);
        }

        return text(withWarning(payload, out));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "list_catalog_tags",
    {
      title: "List catalog tags",
      description:
        "List every tag in the HyperFrames template catalog with how many items carry it. " +
        "Use this to discover what kinds of templates exist before calling search_catalog " +
        "with a tag filter.",
      inputSchema: {
        type: z.enum(["block", "component"]).optional().describe("Restrict the counts to one item type"),
      },
    },
    async ({ type }) => {
      try {
        return text({ tags: await listTags({ type }) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_catalog_item",
    {
      title: "Get a catalog item's editing contract",
      description:
        "Get full details for one catalog template: its dimensions, duration, the typed " +
        "`variables` you are allowed to fill in (each with id, type, label, description and " +
        "default value), the list of files it ships, and its TEMPLATE.md editing contract " +
        "stating explicitly which parts are editable and which are protected. Always call " +
        "this before get_catalog_item_source — filling a template through its declared " +
        "variables is what keeps the animation intact.",
      inputSchema: {
        name: z.string().describe("Exact item name from search_catalog, e.g. 'ai-chat-reveal'"),
        type: z.enum(["block", "component"]).optional().describe("Optional; resolved automatically when omitted"),
      },
    },
    async ({ name, type }) => {
      try {
        const out = await getCatalogItem(name, type);
        return text(
          withWarning(
            {
              name: out.item.name,
              type: out.itemType,
              title: out.item.title,
              description: out.item.description,
              tags: out.item.tags,
              dimensions: out.item.dimensions,
              duration: out.item.duration,
              variables: out.item.variables ?? [],
              files: (out.item.files ?? []).map((f) => f.path),
              editing_contract: out.templateDoc ?? "(este item não declara TEMPLATE.md)",
            },
            out,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_catalog_item_source",
    {
      title: "Get a catalog item's source code",
      description:
        "Get the actual HTML/CSS/JS source of a catalog template, so you can adapt it into a " +
        "composition. Call get_catalog_item first to learn which variables are editable and " +
        "what the template protects. Large files are truncated — pass `path` to request one " +
        "specific file listed by get_catalog_item.",
      inputSchema: {
        name: z.string().describe("Exact item name from search_catalog"),
        type: z.enum(["block", "component"]).optional().describe("Optional; resolved automatically when omitted"),
        path: z.string().optional().describe("Specific file to fetch; defaults to the item's main HTML file"),
      },
    },
    async ({ name, type, path }) => {
      try {
        const out = await getCatalogItemSource(name, type, path);
        const body = truncate(out.body);
        return text(
          withWarning(
            {
              name,
              path: out.path,
              available_files: out.availableFiles,
              bytes: body.bytes,
              truncated: body.truncated,
              source: body.text,
            },
            out,
          ),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
}
