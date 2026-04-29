// Inline ULID. Crockford base32, 26 chars, monotonic within ms.
// 10 chars timestamp (ms since epoch) + 16 chars randomness.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTs = 0;
// `Uint8Array<ArrayBufferLike>` (rather than the inferred `<ArrayBuffer>`)
// admits assignment from incRand's copy, which TS narrows to ArrayBufferLike.
let lastRand: Uint8Array<ArrayBufferLike> = new Uint8Array(16);

function encodeTime(ms: number): string {
  let t = ms;
  const out = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    out[i] = ALPHABET[t % 32]!;
    t = Math.floor(t / 32);
  }
  return out.join("");
}

function freshRand(): Uint8Array {
  const r = new Uint8Array(16);
  for (let i = 0; i < 16; i++) r[i] = Math.floor(Math.random() * 32);
  return r;
}

function incRand(prev: Uint8Array): Uint8Array {
  const r = new Uint8Array(prev);
  for (let i = 15; i >= 0; i--) {
    if (r[i]! < 31) { r[i] = r[i]! + 1; return r; }
    r[i] = 0;
  }
  // Overflow — extremely unlikely in practice; fall back to fresh randomness.
  return freshRand();
}

export function ulid(seedTime?: number): string {
  const t = seedTime ?? Date.now();
  let rand: Uint8Array;
  if (seedTime === undefined && t === lastTs) {
    rand = incRand(lastRand);
  } else {
    rand = freshRand();
  }
  if (seedTime === undefined) {
    lastTs = t;
    lastRand = rand;
  }
  let randStr = "";
  for (let i = 0; i < 16; i++) randStr += ALPHABET[rand[i]!];
  return encodeTime(t) + randStr;
}
