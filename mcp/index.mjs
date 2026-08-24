// Plugin Fastify que expõe o MCP de autoria HyperFrames em /mcp.
//
// Transporte Streamable HTTP em modo STATELESS: uma instância de McpServer +
// transport por requisição, descartada ao final. É o `httpStreamable`, default do
// nó MCP Client Tool do n8n. Stateless porque o agente do n8n faz chamadas
// independentes — não há nada que valha a pena manter entre elas, e sessões
// exigiriam limpeza e expiração que só criariam bugs de estado.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerTools } from "./tools.mjs";

const SERVER_INFO = {
  name: "hyperframes-authoring",
  version: "1.0.0",
};

const INSTRUCTIONS =
  "Reference server for authoring HyperFrames video compositions (HTML rendered to video). " +
  "Call get_composition_contract before writing any composition HTML — it carries the " +
  "required data-* attributes and the determinism rules that make a composition renderable. " +
  "Use search_catalog / get_catalog_item / get_catalog_item_source to reuse ready-made " +
  "transitions, text effects and scene templates instead of writing motion from scratch.";

export default async function mcpPlugin(fastify) {
  // O SDK precisa do corpo bruto: ele mesmo parseia o JSON-RPC. Encapsulado neste
  // escopo, então o parsing JSON das rotas da API principal não é afetado.
  fastify.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    done(null, body);
  });

  const handle = async (request, reply) => {
    const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
    const transport = new StreamableHTTPServerTransport({
      // undefined = stateless: nenhum Mcp-Session-Id é emitido nem exigido.
      sessionIdGenerator: undefined,
    });

    // Fastify não pode responder depois que o transport assume o socket.
    reply.hijack();

    try {
      registerTools(server);
      await server.connect(transport);

      let parsedBody;
      if (typeof request.body === "string" && request.body.length > 0) {
        try {
          parsedBody = JSON.parse(request.body);
        } catch {
          request.raw.destroy();
          return;
        }
      }

      await transport.handleRequest(request.raw, reply.raw, parsedBody);
    } catch (err) {
      request.log.error({ err }, "Falha ao tratar requisição MCP");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Erro interno do MCP: ${err.message}` },
            id: null,
          }),
        );
      } else {
        reply.raw.end();
      }
    } finally {
      // Stateless: nada sobrevive à requisição. Fechar os dois evita vazar
      // listeners a cada chamada do agente.
      transport.close().catch(() => {});
      server.close().catch(() => {});
    }
  };

  // Rotas explícitas, sem catch-all — nenhuma rota existente é interceptada e um
  // path inexistente continua caindo no 404 do Fastify.
  // POST = chamadas JSON-RPC. GET = stream SSE de server-push (o SDK responde 405
  // quando não há stream a abrir, que é o correto em modo stateless).
  for (const method of ["POST", "GET", "DELETE"]) {
    fastify.route({ method, url: "/", handler: handle, schema: { hide: true } });
  }
}
