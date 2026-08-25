// Rede de segurança contra Chromium órfão.
//
// Um Chromium legítimo é SEMPRE filho do processo `hyperframes render` ou
// `hyperframes preview` que o abriu. Quando esse pai morre sem levar os filhos
// junto, o kernel reparenta os netos para o PID 1 — o tini do `init: true`, que
// reapa zumbi mas não mata órfão vivo. O processo fica lá, consumindo CPU e shm,
// até o container reiniciar.
//
// Daí a regra: ppid === 1 + cmdline de Chromium é a assinatura exata do órfão.
//
// Com o kill de grupo de processos funcionando (detached + kill(-pid)), este
// varredor deveria nunca encontrar nada. Se encontrar, é sinal de que algum
// caminho ainda solta filho — por isso todo kill sai como warn no log.
//
// O acesso a /proc é injetado para dar para testar sem Linux e sem processo real.

// /proc/<pid>/stat: "pid (comm) state ppid pgrp ...". O comm é livre — pode conter
// espaço e parêntese —, então o único ponto de ancoragem confiável é o ÚLTIMO ")".
// Depois dele vêm state e ppid, nessa ordem.
export function parsePpid(statContent) {
  if (typeof statContent !== "string") return null;
  const close = statContent.lastIndexOf(")");
  if (close === -1) return null;
  const fields = statContent
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return fields[1] ?? null; // [0] = state, [1] = ppid
}

export function isChromiumCmdline(cmdline) {
  return /chrom(e|ium)/i.test(cmdline ?? "");
}

// reader: { listPids(), readStat(pid), readCmdline(pid) }
// Qualquer leitura pode falhar (o processo morreu no meio da varredura) — nesse
// caso o pid é simplesmente ignorado.
export function scanOrphans(reader, { selfPid = process.pid } = {}) {
  const orphans = [];
  for (const pid of reader.listPids()) {
    // Nunca o PID 1 (matá-lo derruba o container) nem o próprio servidor.
    if (pid === "1" || pid === String(selfPid)) continue;
    let cmdline, ppid;
    try {
      cmdline = (reader.readCmdline(pid) ?? "").split("\0").join(" ").trim();
      if (!isChromiumCmdline(cmdline)) continue;
      ppid = parsePpid(reader.readStat(pid));
    } catch {
      continue;
    }
    if (ppid !== "1") continue;
    orphans.push({ pid, cmdline });
  }
  return orphans;
}

// Duas passadas antes de matar: a primeira só registra, a segunda executa.
//
// Um processo pode aparecer com ppid=1 por um instante durante um spawn normal
// (o pai ainda não terminou de se estabelecer). Exigir que ele continue órfão na
// varredura seguinte custa um intervalo e elimina esse falso positivo. A cmdline
// é comparada junto para não pegar um PID reciclado por outro processo.
export function createOrphanJanitor({ reader, kill, selfPid = process.pid }) {
  let seen = new Map(); // pid → cmdline observada na passada anterior

  return {
    sweep() {
      const orphans = scanOrphans(reader, { selfPid });
      const killed = [];
      const pending = [];
      const next = new Map();

      for (const orphan of orphans) {
        if (seen.get(orphan.pid) === orphan.cmdline) {
          // Já estava órfão na passada anterior, e é o mesmo processo: mata.
          // Não volta para `next` — ou morreu, ou reaparece na próxima varredura
          // e recomeça o ciclo de duas passadas.
          if (kill(orphan.pid)) killed.push(orphan);
        } else {
          next.set(orphan.pid, orphan.cmdline);
          pending.push(orphan);
        }
      }

      seen = next; // pid que deixou de ser órfão é esquecido
      return { killed, pending };
    },

    pendingCount: () => seen.size,
  };
}
