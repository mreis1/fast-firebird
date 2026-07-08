import type { WireFilter } from '../transport.js';

/**
 * RC4 stream cipher. Implemented in TS because OpenSSL 3 (Node ≥17) ships
 * RC4 only in the legacy provider, so node:crypto cannot be relied upon.
 * Keyed with the 20-byte SRP session key; separate instances per direction.
 */
class Rc4 {
  private readonly s = new Uint8Array(256);
  private i = 0;
  private j = 0;

  constructor(key: Buffer) {
    const s = this.s;
    for (let k = 0; k < 256; k++) s[k] = k;
    let j = 0;
    for (let k = 0; k < 256; k++) {
      j = (j + s[k]! + key[k % key.length]!) & 0xff;
      const t = s[k]!;
      s[k] = s[j]!;
      s[j] = t;
    }
  }

  process(data: Buffer): Buffer {
    const out = Buffer.allocUnsafe(data.length);
    const s = this.s;
    let { i, j } = this;
    for (let k = 0; k < data.length; k++) {
      i = (i + 1) & 0xff;
      j = (j + s[i]!) & 0xff;
      const t = s[i]!;
      s[i] = s[j]!;
      s[j] = t;
      out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
    }
    this.i = i;
    this.j = j;
    return out;
  }
}

export class Arc4Filter implements WireFilter {
  private readonly tx: Rc4;
  private readonly rx: Rc4;

  constructor(sessionKey: Buffer) {
    this.tx = new Rc4(sessionKey);
    this.rx = new Rc4(sessionKey);
  }

  send(data: Buffer): Buffer {
    return this.tx.process(data);
  }

  receive(data: Buffer): Buffer {
    return this.rx.process(data);
  }
}
