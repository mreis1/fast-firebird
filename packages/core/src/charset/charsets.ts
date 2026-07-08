/**
 * Firebird character sets — ids taken from firebird/src/intl/charsets.h.
 * `node` marks encodings Buffer handles natively (fast path);
 * `iconv` is the iconv-lite encoding name used otherwise.
 */

export interface CharsetInfo {
  id: number;
  name: string;
  /** Maximum bytes per character (used to size CHAR/VARCHAR buffers). */
  maxBytesPerChar: number;
  node?: BufferEncoding;
  iconv?: string;
  /** True when values must be returned as raw Buffers (OCTETS). */
  binary?: boolean;
}

const defs: Array<[id: number, name: string, maxBytes: number, node?: BufferEncoding, iconv?: string]> = [
  [0, 'NONE', 1],
  [1, 'OCTETS', 1],
  [2, 'ASCII', 1, 'latin1'],
  [3, 'UNICODE_FSS', 3, 'utf8'], // legacy UTF-8 variant; decode as utf8
  [4, 'UTF8', 4, 'utf8'],
  [5, 'SJIS_0208', 2, undefined, 'shiftjis'],
  [6, 'EUCJ_0208', 2, undefined, 'eucjp'],
  [9, 'DOS737', 1, undefined, 'cp737'],
  [10, 'DOS437', 1, undefined, 'cp437'],
  [11, 'DOS850', 1, undefined, 'cp850'],
  [12, 'DOS865', 1, undefined, 'cp865'],
  [13, 'DOS860', 1, undefined, 'cp860'],
  [14, 'DOS863', 1, undefined, 'cp863'],
  [15, 'DOS775', 1, undefined, 'cp775'],
  [16, 'DOS858', 1, undefined, 'cp858'],
  [17, 'DOS862', 1, undefined, 'cp862'],
  [18, 'DOS864', 1, undefined, 'cp864'],
  [21, 'ISO8859_1', 1, 'latin1'],
  [22, 'ISO8859_2', 1, undefined, 'iso-8859-2'],
  [23, 'ISO8859_3', 1, undefined, 'iso-8859-3'],
  [34, 'ISO8859_4', 1, undefined, 'iso-8859-4'],
  [35, 'ISO8859_5', 1, undefined, 'iso-8859-5'],
  [36, 'ISO8859_6', 1, undefined, 'iso-8859-6'],
  [37, 'ISO8859_7', 1, undefined, 'iso-8859-7'],
  [38, 'ISO8859_8', 1, undefined, 'iso-8859-8'],
  [39, 'ISO8859_9', 1, undefined, 'iso-8859-9'],
  [40, 'ISO8859_13', 1, undefined, 'iso-8859-13'],
  [44, 'KSC_5601', 2, undefined, 'euckr'],
  [45, 'DOS852', 1, undefined, 'cp852'],
  [46, 'DOS857', 1, undefined, 'cp857'],
  [47, 'DOS861', 1, undefined, 'cp861'],
  [48, 'DOS866', 1, undefined, 'cp866'],
  [49, 'DOS869', 1, undefined, 'cp869'],
  [50, 'CYRL', 1, undefined, 'cp866'],
  [51, 'WIN1250', 1, undefined, 'win1250'],
  [52, 'WIN1251', 1, undefined, 'win1251'],
  [53, 'WIN1252', 1, undefined, 'win1252'],
  [54, 'WIN1253', 1, undefined, 'win1253'],
  [55, 'WIN1254', 1, undefined, 'win1254'],
  [56, 'BIG_5', 2, undefined, 'big5'],
  [57, 'GB_2312', 2, undefined, 'gb2312'],
  [58, 'WIN1255', 1, undefined, 'win1255'],
  [59, 'WIN1256', 1, undefined, 'win1256'],
  [60, 'WIN1257', 1, undefined, 'win1257'],
  [63, 'KOI8R', 1, undefined, 'koi8-r'],
  [64, 'KOI8U', 1, undefined, 'koi8-u'],
  [65, 'WIN1258', 1, undefined, 'win1258'],
  [66, 'TIS620', 1, undefined, 'tis620'],
  [67, 'GBK', 2, undefined, 'gbk'],
  [68, 'CP943C', 2, undefined, 'shiftjis'],
  [69, 'GB18030', 4, undefined, 'gb18030'],
];

export const CHARSETS_BY_NAME = new Map<string, CharsetInfo>();
export const CHARSETS_BY_ID = new Map<number, CharsetInfo>();

for (const [id, name, maxBytesPerChar, node, iconv] of defs) {
  const info: CharsetInfo = { id, name, maxBytesPerChar, node, iconv, binary: name === 'OCTETS' };
  CHARSETS_BY_NAME.set(name, info);
  CHARSETS_BY_ID.set(id, info);
}

export const CS_NONE = 0;
export const CS_OCTETS = 1;
export const CS_UTF8 = 4;
export const CS_DYNAMIC = 127;

/** Accepts common aliases ("utf-8", "latin1", "WIN_1252") and returns the Firebird charset. */
export function resolveCharset(name: string): CharsetInfo {
  const upper = name.toUpperCase().replace(/[-\s]/g, '');
  const alias: Record<string, string> = {
    UTF8: 'UTF8',
    LATIN1: 'ISO8859_1',
    ISO88591: 'ISO8859_1',
    BINARY: 'OCTETS',
  };
  const key = alias[upper] ?? upper.replace(/^WIN_/, 'WIN');
  const found = CHARSETS_BY_NAME.get(key) ?? CHARSETS_BY_NAME.get(upper);
  if (!found) throw new Error(`Unknown Firebird charset: ${name}`);
  return found;
}
