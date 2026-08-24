// Decisão de qual fonte o `POST /preview` vai usar: HTML enviado no corpo ou um
// diretório de preview que já está em disco.
//
// Vive fora do server.mjs porque importar aquele arquivo sobe o servidor — nada
// lá dentro é testável em unidade. Aqui não há I/O: quem toca disco é o handler,
// que passa o resultado do existsSync em `previewDirExists`.

// Formato exato de randomUUID(). Usado para validar ids vindos do cliente antes
// de compô-los num path.
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Retorna { ok: true, mode: "html" | "reuse" } ou { ok: false, status, error }.
//
// `hasExtras` = o cliente mandou compositions/assets junto. Com `preview_id` isso
// é recusado em vez de ignorado em silêncio: os arquivos já vivem no diretório do
// preview, e aceitar sem aplicar esconderia que nada aconteceu.
export function resolvePreviewSource({
  html,
  previewId,
  hasExtras = false,
  previewDirExists = false,
  reopenEnabled = true,
} = {}) {
  const bad = (error) => ({ ok: false, status: 400, error });

  if (previewId && !reopenEnabled) {
    return bad(
      'Reabertura de preview desligada (PREVIEW_REOPEN=false). Envie "html".',
    );
  }

  // Exatamente um dos dois — mesma regra do POST /render.
  if (!html && !previewId) {
    return bad('Informe "html" ou "preview_id" (um dos dois)');
  }
  if (html && previewId) {
    return bad('"html" e "preview_id" são mutuamente exclusivos');
  }

  if (!previewId) return { ok: true, mode: "html" };

  // O previewId vem do cliente e é concatenado num path — restringe ao formato
  // exato que randomUUID() gera, o que também barra qualquer traversal.
  if (!UUID_RE.test(previewId)) {
    return bad(`preview_id inválido: "${previewId}"`);
  }
  if (hasExtras) {
    return bad(
      'Com "preview_id" os arquivos já estão no diretório do preview: ' +
        '"compositions" e "assets" não podem ser reenviados. Para trocar arquivos, ' +
        'crie um preview novo com "html".',
    );
  }
  if (!previewDirExists) {
    return {
      ok: false,
      status: 404,
      error:
        `Preview "${previewId}" não encontrado (expirado ou nunca criado). ` +
        'Crie um novo com POST /preview {"html": ...}.',
    };
  }

  return { ok: true, mode: "reuse" };
}
