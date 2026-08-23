// Polyfill de "secure context" para a HyperFrames Studio.
//
// O bundle da Studio (node_modules/hyperframes/dist/studio/index.js) chama
// `globalThis.crypto.randomUUID()` em createStudioWriteToken() e
// `globalThis.crypto.subtle.digest("SHA-256", ...)` em studioFileContentVersion()
// SEM fallback. As duas APIs são secure-context only: o navegador só as expõe em
// HTTPS ou localhost. Servindo a Studio em http://<IP>:<porta>, ambas ficam
// `undefined` e TODO save/mutação quebra:
//
//   Couldn't save "...": globalThis.crypto.randomUUID is not a function
//   Cannot read properties of undefined (reading 'digest')
//   Couldn't save index.html — your latest edits are NOT persisted
//   Failed to save animated edit.
//
// Este arquivo é injetado pelo servidor no <head> do HTML da Studio (ver
// server.mjs, rotas do proxy), antes do bundle — que é `type="module"`, portanto
// deferido, então um script clássico no <head> sempre roda primeiro.
//
// Tudo aqui está sob guarda: em HTTPS ou localhost o navegador já expõe as APIs
// nativas e este script é um no-op completo.
(function () {
  "use strict";

  var g = typeof globalThis !== "undefined" ? globalThis : window;
  var c = g.crypto;
  if (!c) return; // sem nada em que se apoiar — melhor falhar como falharia hoje

  // ── crypto.randomUUID ──────────────────────────────────────────────────────
  // getRandomValues NÃO é secure-context gated, então continua disponível em
  // HTTP e serve de base para um UUID v4 de verdade (RFC 4122).
  if (typeof c.randomUUID !== "function" && typeof c.getRandomValues === "function") {
    var HEX = [];
    for (var i = 0; i < 256; i++) HEX.push((i + 0x100).toString(16).slice(1));

    try {
      c.randomUUID = function randomUUID() {
        var b = c.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; // versão 4
        b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
        return (
          HEX[b[0]] + HEX[b[1]] + HEX[b[2]] + HEX[b[3]] + "-" +
          HEX[b[4]] + HEX[b[5]] + "-" +
          HEX[b[6]] + HEX[b[7]] + "-" +
          HEX[b[8]] + HEX[b[9]] + "-" +
          HEX[b[10]] + HEX[b[11]] + HEX[b[12]] + HEX[b[13]] + HEX[b[14]] + HEX[b[15]]
        );
      };
    } catch (err) {
      /* propriedade não gravável neste navegador — deixa como estava */
    }
  }

  // ── crypto.subtle.digest("SHA-256", ...) ───────────────────────────────────
  // SHA-256 em JS puro (FIPS 180-4). Só o `digest` é implementado: é o único
  // método que a Studio usa, e falhar alto em qualquer outro evita mascarar um
  // uso futuro com um stub silencioso.
  if (!c.subtle) {
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];

    var sha256 = function (bytes) {
      var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
      var h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

      // padding: 0x80, zeros, e o tamanho em bits como big-endian de 64 bits
      var len = bytes.length;
      var withPad = ((len + 8) >> 6 << 6) + 64;
      var m = new Uint8Array(withPad);
      m.set(bytes);
      m[len] = 0x80;
      var bitLen = len * 8;
      // len é limitado pelo heap do JS, então os 32 bits altos vêm de uma divisão
      var hi = Math.floor(bitLen / 0x100000000);
      var lo = bitLen >>> 0;
      m[withPad - 8] = (hi >>> 24) & 0xff;
      m[withPad - 7] = (hi >>> 16) & 0xff;
      m[withPad - 6] = (hi >>> 8) & 0xff;
      m[withPad - 5] = hi & 0xff;
      m[withPad - 4] = (lo >>> 24) & 0xff;
      m[withPad - 3] = (lo >>> 16) & 0xff;
      m[withPad - 2] = (lo >>> 8) & 0xff;
      m[withPad - 1] = lo & 0xff;

      var w = new Uint32Array(64);
      for (var off = 0; off < withPad; off += 64) {
        for (var t = 0; t < 16; t++) {
          var j = off + t * 4;
          w[t] = ((m[j] << 24) | (m[j + 1] << 16) | (m[j + 2] << 8) | m[j + 3]) >>> 0;
        }
        for (var t2 = 16; t2 < 64; t2++) {
          var w15 = w[t2 - 15], w2 = w[t2 - 2];
          var s0 = (((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3)) >>> 0;
          var s1 = (((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10)) >>> 0;
          w[t2] = (w[t2 - 16] + s0 + w[t2 - 7] + s1) >>> 0;
        }

        var a = h0, b = h1, cc = h2, d = h3, e = h4, f = h5, g2 = h6, hh = h7;
        for (var t3 = 0; t3 < 64; t3++) {
          var S1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
          var ch = ((e & f) ^ (~e & g2)) >>> 0;
          var temp1 = (hh + S1 + ch + K[t3] + w[t3]) >>> 0;
          var S0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
          var maj = ((a & b) ^ (a & cc) ^ (b & cc)) >>> 0;
          var temp2 = (S0 + maj) >>> 0;

          hh = g2; g2 = f; f = e;
          e = (d + temp1) >>> 0;
          d = cc; cc = b; b = a;
          a = (temp1 + temp2) >>> 0;
        }

        h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + cc) >>> 0; h3 = (h3 + d) >>> 0;
        h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g2) >>> 0; h7 = (h7 + hh) >>> 0;
      }

      var out = new Uint8Array(32);
      var hs = [h0, h1, h2, h3, h4, h5, h6, h7];
      for (var k = 0; k < 8; k++) {
        out[k * 4] = (hs[k] >>> 24) & 0xff;
        out[k * 4 + 1] = (hs[k] >>> 16) & 0xff;
        out[k * 4 + 2] = (hs[k] >>> 8) & 0xff;
        out[k * 4 + 3] = hs[k] & 0xff;
      }
      return out.buffer;
    };

    var toBytes = function (data) {
      if (data instanceof ArrayBuffer) return new Uint8Array(data);
      if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      }
      throw new TypeError("crypto.subtle.digest: esperado BufferSource");
    };

    var nameOf = function (algorithm) {
      var n = typeof algorithm === "string" ? algorithm : algorithm && algorithm.name;
      return String(n || "").toUpperCase();
    };

    try {
      Object.defineProperty(c, "subtle", {
        configurable: true,
        value: {
          digest: function digest(algorithm, data) {
            var alg = nameOf(algorithm);
            if (alg !== "SHA-256") {
              return Promise.reject(
                new Error(
                  "crypto.subtle polyfill: só SHA-256 é suportado (pedido: " + alg + "). " +
                  "Sirva a Studio via HTTPS para obter a WebCrypto nativa."
                )
              );
            }
            try {
              return Promise.resolve(sha256(toBytes(data)));
            } catch (err) {
              return Promise.reject(err);
            }
          }
        }
      });
    } catch (err) {
      /* não dá pra definir — deixa como estava */
    }
  }

  // ── navigator.clipboard.writeText ──────────────────────────────────────────
  // Também secure-context only. A Studio usa em ~10 botões "Copy"; sem isso eles
  // lançam. Não bloqueia o save, mas é a mesma causa raiz.
  if (g.navigator && !g.navigator.clipboard) {
    try {
      Object.defineProperty(g.navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: function writeText(text) {
            return new Promise(function (resolve, reject) {
              try {
                var ta = document.createElement("textarea");
                ta.value = String(text);
                ta.setAttribute("readonly", "");
                ta.style.position = "fixed";
                ta.style.top = "-9999px";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                var ok = document.execCommand("copy");
                document.body.removeChild(ta);
                ok ? resolve() : reject(new Error("Falha ao copiar"));
              } catch (err) {
                reject(err);
              }
            });
          }
        }
      });
    } catch (err) {
      /* não dá pra definir — deixa como estava */
    }
  }
})();
