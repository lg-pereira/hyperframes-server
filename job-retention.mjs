// Política de retenção dos diretórios de job do render (WORK_DIR/hf_jobs).
//
// Até aqui nada varria esse diretório: o único caminho de limpeza era o timer de
// 1 min disparado quando o DOWNLOAD começa. Job que falhou, ou que ninguém baixou,
// ficava para sempre — com os frames PNG intermediários, que num render longo são
// vários GB. Quando /tmp enche, o Chromium crasha com erros que não parecem falta
// de disco, e o diagnóstico vai para o lugar errado.
//
// Função pura: quem lê o disco é o sweep no server.mjs, que passa os flags já
// resolvidos. Assim a política (o que é velho, o que é intocável) fica testável.

export const DEFAULT_ERROR_RETENTION_MS = 60 * 60 * 1000; // 1h
export const DEFAULT_DONE_RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

// { sweep: boolean, reason: string }
//
// `isActive` = existe um processo de render vivo para este job. É a única condição
// que protege incondicionalmente, espelhando o "nunca remove o preview ATIVO" do
// sweepOldPreviews(): um render de 10 min não pode ser varrido por baixo do
// processo que está escrevendo nele.
export function shouldSweepJob(
  { hasDone = false, hasError = false, ageMs = 0, isActive = false } = {},
  {
    errorRetentionMs = DEFAULT_ERROR_RETENTION_MS,
    doneRetentionMs = DEFAULT_DONE_RETENTION_MS,
  } = {},
) {
  if (isActive) return { sweep: false, reason: "render em andamento" };

  if (hasError) {
    return ageMs > errorRetentionMs
      ? { sweep: true, reason: "job com erro expirado" }
      : { sweep: false, reason: "job com erro dentro da retenção" };
  }

  if (hasDone) {
    return ageMs > doneRetentionMs
      ? { sweep: true, reason: "job concluído expirado" }
      : { sweep: false, reason: "job concluído dentro da retenção" };
  }

  // Nem done nem error e sem processo vivo: o render morreu sem conseguir escrever
  // o desfecho — container reiniciado no meio, OOM kill, SIGKILL. Esse diretório
  // ficaria em "processing" para sempre, porque quem escreveria error.txt já morreu.
  // Usa a retenção curta: não há vídeo para baixar, só lixo.
  return ageMs > errorRetentionMs
    ? { sweep: true, reason: "job órfão em processing" }
    : { sweep: false, reason: "job recente" };
}

// Diretórios que o sweep nunca deve olhar: lint-* e check-* já se limpam sozinhos
// no finally dos respectivos handlers, e varrê-los no meio de uma requisição
// síncrona apagaria o diretório debaixo do CLI em execução.
export function isJobDir(name) {
  return !name.startsWith("lint-") && !name.startsWith("check-");
}
