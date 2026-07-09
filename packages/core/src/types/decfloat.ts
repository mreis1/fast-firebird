/**
 * IEEE 754-2008 decimal floating point decoding (Firebird DECFLOAT(16)/(34)),
 * which uses densely-packed-decimal (DPD) coefficient encoding, big-endian on
 * the wire. Decodes to an exact decimal string (values can exceed JS `number`
 * precision, so a string is the faithful representation).
 */

// DPD declet (10 bits) → 3 decimal digits. Built by inverting the well-defined
// BCD→DPD encoding, so only canonical patterns (the ones Firebird emits) map.
const DPD_TO_INT = buildDpdTable();

function buildDpdTable(): Uint16Array {
  const table = new Uint16Array(1024);
  for (let d2 = 0; d2 < 10; d2++) {
    for (let d1 = 0; d1 < 10; d1++) {
      for (let d0 = 0; d0 < 10; d0++) {
        table[encodeDeclet(d2, d1, d0)] = d2 * 100 + d1 * 10 + d0;
      }
    }
  }
  return table;
}

/** BCD triple → 10-bit DPD (Cowlishaw's encoding, 8-case form). */
function encodeDeclet(d2: number, d1: number, d0: number): number {
  const a = (d2 >> 3) & 1, b = (d2 >> 2) & 1, c = (d2 >> 1) & 1, d = d2 & 1;
  const e = (d1 >> 3) & 1, f = (d1 >> 2) & 1, g = (d1 >> 1) & 1, h = d1 & 1;
  const i = (d0 >> 3) & 1, j = (d0 >> 2) & 1, k = (d0 >> 1) & 1, m = d0 & 1;
  const aei = (a << 2) | (e << 1) | i;
  let hi3: number[], mid3: number[], lo4: number[];
  switch (aei) {
    case 0b000: hi3 = [b, c, d]; mid3 = [f, g, h]; lo4 = [0, j, k, m]; break;
    case 0b001: hi3 = [b, c, d]; mid3 = [f, g, h]; lo4 = [1, 0, 0, m]; break;
    case 0b010: hi3 = [b, c, d]; mid3 = [j, k, h]; lo4 = [1, 0, 1, m]; break;
    case 0b011: hi3 = [b, c, d]; mid3 = [1, 0, h]; lo4 = [1, 1, 1, m]; break;
    case 0b100: hi3 = [j, k, d]; mid3 = [f, g, h]; lo4 = [1, 1, 0, m]; break;
    case 0b101: hi3 = [f, g, d]; mid3 = [0, 1, h]; lo4 = [1, 1, 1, m]; break;
    case 0b110: hi3 = [j, k, d]; mid3 = [0, 0, h]; lo4 = [1, 1, 1, m]; break;
    default: hi3 = [0, 0, d]; mid3 = [1, 1, h]; lo4 = [1, 1, 1, m]; break; // 0b111
  }
  const bits = [...hi3, ...mid3, ...lo4];
  return bits.reduce((acc, bit) => (acc << 1) | bit, 0);
}

interface DecimalFormat {
  width: 8 | 16;
  bias: number;
  expContBits: bigint;
  declets: number;
}

const DEC64: DecimalFormat = { width: 8, bias: 398, expContBits: 8n, declets: 5 };
const DEC128: DecimalFormat = { width: 16, bias: 6176, expContBits: 12n, declets: 11 };

/** Decode a Firebird DECFLOAT (8 or 16 bytes, big-endian) to an exact decimal string. */
export function decodeDecFloat(buf: Buffer): string {
  const fmt = buf.length === 8 ? DEC64 : DEC128;
  const totalBits = BigInt(fmt.width * 8);
  let v = 0n;
  for (const byte of buf) v = (v << 8n) | BigInt(byte);

  const sign = (v >> (totalBits - 1n)) & 1n;
  const combo = Number((v >> (totalBits - 6n)) & 0x1fn); // 5-bit combination field G0..G4
  const expCont = (v >> (totalBits - 6n - fmt.expContBits)) & ((1n << fmt.expContBits) - 1n);
  const coeffCont = v & ((1n << BigInt(fmt.declets * 10)) - 1n);

  const neg = sign === 1n;

  // Combination field → special value, or (exponent MSBs, most-significant digit).
  if (combo >= 0b11110) return combo === 0b11110 ? (neg ? '-Infinity' : 'Infinity') : 'NaN';
  let expMsb: number, msd: number;
  if (combo >> 3 === 0b11) {
    expMsb = (combo >> 1) & 0b11;
    msd = 8 + (combo & 1);
  } else {
    expMsb = (combo >> 3) & 0b11;
    msd = combo & 0b111;
  }

  const biasedExp = (BigInt(expMsb) << fmt.expContBits) | expCont;
  const exponent = Number(biasedExp) - fmt.bias;

  // Coefficient digits: leading MSD, then each 10-bit declet → 3 digits.
  let digits = String(msd);
  for (let d = fmt.declets - 1; d >= 0; d--) {
    const declet = Number((coeffCont >> BigInt(d * 10)) & 0x3ffn);
    digits += String(DPD_TO_INT[declet]).padStart(3, '0');
  }
  digits = digits.replace(/^0+(?=\d)/, ''); // strip leading zeros, keep one

  return format(neg, digits, exponent);
}

/** Assemble sign + coefficient digits + base-10 exponent into a plain decimal string. */
function format(neg: boolean, digits: string, exp: number): string {
  const s = neg ? '-' : '';
  if (digits === '0') return neg ? '-0' : '0';
  if (exp === 0) return s + digits;
  if (exp > 0) return s + digits + '0'.repeat(exp);
  const point = digits.length + exp; // exp < 0
  if (point > 0) return s + digits.slice(0, point) + '.' + digits.slice(point);
  return s + '0.' + '0'.repeat(-point) + digits;
}
