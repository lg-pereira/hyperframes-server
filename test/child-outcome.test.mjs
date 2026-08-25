// Prova que o desfecho de um filho sai do `exit`, não do `close`.
//
// O teste central é o de regressão do bug real: um processo que SAI deixando um
// neto vivo com o stdio herdado. Esse neto segura o write-end do pipe, o `close`
// do filho nunca chega, e quem esperava por ele fica pendurado para sempre — foi
// exatamente o que prendeu um render em "processing" por 1800s na VPS, com o
// mutex de concorrência devolvendo 429 para todo mundo enquanto isso.
//
// Os processos são reais, não mocks: o bug é do kernel/libuv, não da nossa lógica.
// Um mock de EventEmitter passaria mesmo com o código errado.
//
// Rodar com: npm test

import { spawn } from "node:child_process";

const { settleOnExit } = await import(
  new URL("../child-outcome.mjs", import.meta.url)
);

let fails = 0;
const ok = (c, l, e = "") => {
  console.log(`  ${c ? "PASS" : "FAIL"}  ${l}${e ? "  " + e : ""}`);
  if (!c) fails++;
};

const settle = (proc, drainMs) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    settleOnExit(proc, {
      drainMs,
      killLeftovers: () => {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {}
      },
      onSettled: (outcome) => resolve({ ...outcome, ms: Date.now() - t0 }),
    });
  });

// ─── Regressão: filho sai, neto segura os pipes ──────────────────────────────
// `detached` reproduz o spawn do render: é o que dá ao filho um grupo próprio, e
// é esse grupo que o killLeftovers alcança.
const vazando = spawn(
  process.execPath,
  [
    "-e",
    'require("child_process").spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{stdio:"inherit"});process.exit(7)',
  ],
  { detached: true },
);
vazando.stdout.resume();
vazando.stderr.resume();

const r1 = await settle(vazando, 300);
ok(
  r1.code === 7,
  "filho que vaza neto → desfecho traz o código real (7)",
  `code=${r1.code}`,
);
ok(r1.leaked === true, "filho que vaza neto → marcado como leaked");
ok(
  r1.ms < 3_000,
  "filho que vaza neto → conclui na janela de drenagem, não fica pendurado",
  `${r1.ms}ms`,
);

// ─── Caminho normal: sem neto, o close chega e não há leak ───────────────────
const limpo = spawn(
  process.execPath,
  ["-e", 'console.log("fim");process.exit(0)'],
  {
    detached: true,
  },
);
limpo.stdout.resume();
limpo.stderr.resume();

const r2 = await settle(limpo, 3_000);
ok(r2.code === 0 && r2.error === null, "processo limpo → code 0 sem erro");
ok(
  r2.leaked === false,
  "processo limpo → close chega, nada é marcado como leaked",
);
ok(r2.ms < 3_000, "processo limpo → não espera a janela inteira", `${r2.ms}ms`);

// ─── stdout completo mesmo concluindo pelo exit ──────────────────────────────
// A razão de existir a janela de drenagem: o `exit` pode chegar antes do último
// chunk. Se o desfecho não esperasse nada, o render.log sairia truncado
// justamente na falha que interessa.
const falante = spawn(
  process.execPath,
  [
    "-e",
    // write com callback: process.exit() descarta o que ainda não foi para o
    // pipe, e o truncamento seria do próprio filho, não do desfecho.
    'process.stdout.write("x".repeat(200000), () => process.exit(3))',
  ],
  { detached: true },
);
let saida = "";
falante.stdout.on("data", (c) => (saida += c));
falante.stderr.resume();

const r3 = await settle(falante, 3_000);
ok(
  r3.code === 3,
  "processo verboso → código real preservado",
  `code=${r3.code}`,
);
ok(
  saida.length === 200_000,
  "processo verboso → stdout inteiro drenado antes do desfecho",
  `${saida.length} bytes`,
);

// ─── Binário inexistente: só "error", sem exit ───────────────────────────────
const inexistente = spawn("/nao/existe/binario-hf", []);
const r4 = await settle(inexistente, 3_000);
ok(r4.error != null, "binário inexistente → desfecho carrega o error");
ok(r4.leaked === false, "binário inexistente → não é leak");

// ─── Desfecho único ──────────────────────────────────────────────────────────
// O guarda que impede o "close" tardio de sobrescrever um desfecho já escrito —
// no server.mjs isso significaria trocar o error.txt real por uma mensagem pior.
let vezes = 0;
const umaVez = spawn(process.execPath, ["-e", "process.exit(1)"], {
  detached: true,
});
umaVez.stdout.resume();
umaVez.stderr.resume();
settleOnExit(umaVez, { drainMs: 50, onSettled: () => vezes++ });
await new Promise((r) => setTimeout(r, 600));
ok(vezes === 1, "onSettled roda exatamente uma vez", `rodou ${vezes}x`);

console.log(
  fails === 0 ? "\nchild-outcome: OK" : `\nchild-outcome: ${fails} FALHA(S)`,
);
process.exit(fails === 0 ? 0 : 1);
