// Prova a detecção de Chromium órfão com um /proc falso em memória.
//
// O bloco de regressão vem primeiro e é o que protege o servidor de si mesmo:
// este código MATA processos. Um falso positivo aqui derruba um render legítimo
// ou o próprio container. As guardas (pai vivo, PID 1, o próprio node, duas
// passadas) são testadas antes de qualquer caso de kill.
//
// Rodar com: npm test

const { parsePpid, isChromiumCmdline, scanOrphans, createOrphanJanitor } =
  await import(new URL("../orphan-scan.mjs", import.meta.url));

let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};

// /proc falso: { pid: { ppid, cmdline } }
const fakeProc = (table) => ({
  listPids: () => Object.keys(table),
  readStat: (pid) => {
    const p = table[pid];
    if (!p) throw new Error("ESRCH");
    return `${pid} (${p.comm ?? "chromium"}) S ${p.ppid} 1 1 0 -1 4194304`;
  },
  readCmdline: (pid) => {
    const p = table[pid];
    if (!p) throw new Error("ESRCH");
    return p.cmdline.split(" ").join("\0");
  },
});

const SELF = 4242;

// ─── Regressão: o que NUNCA pode ser detectado como órfão ────────────────────
const vivos = fakeProc({
  1: { ppid: "0", cmdline: "/sbin/docker-init", comm: "docker-init" },
  100: { ppid: "1", cmdline: "node server.mjs", comm: "node" },
  200: { ppid: "100", cmdline: "node hyperframes render", comm: "node" },
  300: { ppid: "200", cmdline: "/usr/bin/chromium --headless --no-sandbox" },
  [SELF]: {
    ppid: "1",
    cmdline: "node /usr/bin/chromium-wrapper",
    comm: "node",
  },
});
const nenhum = scanOrphans(vivos, { selfPid: SELF });
ok(
  nenhum.length === 0,
  "render saudável → nenhum órfão detectado",
  JSON.stringify(nenhum),
);

const soPid1 = scanOrphans(
  fakeProc({
    1: { ppid: "0", cmdline: "/usr/bin/chromium", comm: "chromium" },
  }),
  { selfPid: SELF },
);
ok(soPid1.length === 0, "PID 1 nunca é candidato, mesmo casando com chromium");

// ─── Detecção do órfão de verdade ────────────────────────────────────────────
const comOrfao = fakeProc({
  1: { ppid: "0", cmdline: "/sbin/docker-init", comm: "docker-init" },
  100: { ppid: "1", cmdline: "node server.mjs", comm: "node" },
  // pai (o CLI) morreu: reparentado para o PID 1
  300: { ppid: "1", cmdline: "/usr/bin/chromium --headless --no-sandbox" },
});
const orfaos = scanOrphans(comOrfao, { selfPid: SELF });
ok(
  orfaos.length === 1 && orfaos[0].pid === "300",
  "chromium com ppid=1 → detectado",
  JSON.stringify(orfaos),
);
ok(
  !orfaos.some((o) => o.pid === "100"),
  "node com ppid=1 não é órfão (a regra exige cmdline de chromium)",
);

// ─── Duas passadas antes de matar ────────────────────────────────────────────
const mortos = [];
const janitor = createOrphanJanitor({
  reader: comOrfao,
  kill: (pid) => {
    mortos.push(pid);
    return true;
  },
  selfPid: SELF,
});

const p1 = janitor.sweep();
ok(
  p1.killed.length === 0 && p1.pending.length === 1,
  "primeira passada só registra, não mata",
  JSON.stringify(p1.killed),
);
const p2 = janitor.sweep();
ok(
  p2.killed.length === 1 && mortos[0] === "300",
  "segunda passada mata o órfão que persistiu",
  JSON.stringify(mortos),
);

// ─── Falso positivo momentâneo ───────────────────────────────────────────────
// Um processo pode aparecer com ppid=1 por um instante durante um spawn. Se na
// passada seguinte ele tem pai vivo, não pode morrer.
let tabela = { 300: { ppid: "1", cmdline: "/usr/bin/chromium --headless" } };
const mortosB = [];
const janitorB = createOrphanJanitor({
  reader: {
    listPids: () => Object.keys(tabela),
    readStat: (pid) => `${pid} (chromium) S ${tabela[pid].ppid} 1 1`,
    readCmdline: (pid) => tabela[pid].cmdline,
  },
  kill: (pid) => {
    mortosB.push(pid);
    return true;
  },
  selfPid: SELF,
});
janitorB.sweep(); // registra
tabela = { 300: { ppid: "200", cmdline: "/usr/bin/chromium --headless" } }; // pai apareceu
janitorB.sweep();
ok(
  mortosB.length === 0,
  "processo que deixou de ser órfão não é morto",
  JSON.stringify(mortosB),
);
ok(
  janitorB.pendingCount() === 0,
  "pid que saiu da lista é esquecido (não fica pendente para sempre)",
);

// ─── PID reciclado ───────────────────────────────────────────────────────────
// Entre duas passadas o PID pode pertencer a outro processo. A cmdline é comparada
// junto justamente para não matar o novo dono na primeira oportunidade.
let reciclada = { 300: { ppid: "1", cmdline: "/usr/bin/chromium --headless" } };
const mortosC = [];
const janitorC = createOrphanJanitor({
  reader: {
    listPids: () => Object.keys(reciclada),
    readStat: (pid) => `${pid} (chromium) S ${reciclada[pid].ppid} 1 1`,
    readCmdline: (pid) => reciclada[pid].cmdline,
  },
  kill: (pid) => {
    mortosC.push(pid);
    return true;
  },
  selfPid: SELF,
});
janitorC.sweep();
reciclada = { 300: { ppid: "1", cmdline: "/usr/bin/chrome --outro-processo" } };
janitorC.sweep();
ok(
  mortosC.length === 0,
  "PID reciclado com outra cmdline recomeça o ciclo de duas passadas",
  JSON.stringify(mortosC),
);

// ─── Leitura que falha no meio da varredura ──────────────────────────────────
const sumindo = {
  listPids: () => ["300"],
  readStat: () => {
    throw new Error("ESRCH");
  },
  readCmdline: () => "/usr/bin/chromium",
};
let explodiu = false;
try {
  scanOrphans(sumindo, { selfPid: SELF });
} catch {
  explodiu = true;
}
ok(
  !explodiu,
  "processo que morre no meio da leitura é ignorado, não quebra a varredura",
);

// ─── parsePpid com comm hostil ───────────────────────────────────────────────
// O comm é livre: pode conter espaço e parêntese. O único ancoradouro é o ÚLTIMO ")".
ok(
  parsePpid("300 (chromium) S 1 300 300 0") === "1",
  "parsePpid: caso simples",
);
ok(
  parsePpid("300 (Chrome_IOThread (x)) S 42 300 300") === "42",
  "parsePpid: comm com parêntese e espaço dentro",
);
ok(parsePpid("lixo") === null, "parsePpid: entrada inválida → null");
ok(parsePpid(undefined) === null, "parsePpid: undefined → null");

ok(
  isChromiumCmdline("/usr/bin/chromium --headless"),
  "cmdline chromium detectada",
);
ok(isChromiumCmdline("/opt/google/chrome/chrome"), "cmdline chrome detectada");
ok(!isChromiumCmdline("node server.mjs"), "cmdline de node não é chromium");
ok(!isChromiumCmdline(undefined), "cmdline ausente não é chromium");

console.log(
  fails === 0
    ? "\n  ORPHAN SCAN: TODOS PASSARAM"
    : `\n  ORPHAN SCAN: ${fails} FALHARAM`,
);
process.exit(fails === 0 ? 0 : 1);
