// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Autonomy / OpenPLC Project
/**
 * MD5 (RFC 1321) over UTF-8 text, synchronous and dependency-free.
 *
 * Program identity only (the value the runtime serves on 0x45), never a
 * security property. `compile()` is synchronous and runs in the browser, so
 * `node:crypto` cannot be used.
 *
 * See also:
 *   src/backend/sha256.ts - the build identity and per-file hashes.
 *   src/index.ts - computes the program md5 when the caller gives none.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5,
  9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11,
  16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
  21,
];

const K = new Uint32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
}

/** Hex MD5 of `text` encoded as UTF-8. */
export function md5Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  // Message + 0x80 + zero padding + 64-bit little-endian bit length, to a 64-byte multiple.
  const blocks = Math.ceil((data.length + 9) / 64);
  const buf = new Uint8Array(blocks * 64);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = data.length * 8;
  view.setUint32(buf.length - 8, bits >>> 0, true);
  view.setUint32(buf.length - 4, Math.floor(bits / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getUint32(off + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + K[i]! + m[g]!) >>> 0;
      const s = S[i]!;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setUint32(0, a0, true);
  out.setUint32(4, b0, true);
  out.setUint32(8, c0, true);
  out.setUint32(12, d0, true);
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += out.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex;
}
