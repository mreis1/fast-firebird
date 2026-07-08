import iconv from 'iconv-lite';
import { CHARSETS_BY_ID, CS_NONE, CS_OCTETS, type CharsetInfo, resolveCharset } from './charsets.js';

/** Context passed to transcode adapters when decoding a value read from the server. */
export interface DecodeContext {
  /** Effective charset name used for this value. */
  charset: string;
  /** Charset declared in the column metadata, if known. */
  declaredCharset?: string;
  fieldName?: string;
  relationName?: string;
  sqlType?: string;
  blobSubtype?: number;
}

/** Context passed to transcode adapters when encoding a parameter for the server. */
export interface EncodeContext {
  charset: string;
  declaredCharset?: string;
  parameterIndex?: number;
  sqlType?: string;
  blobSubtype?: number;
}

export interface FirebirdTranscodeAdapter {
  text?: {
    fromDb(buffer: Buffer, context: DecodeContext): string;
    toDb(value: string, context: EncodeContext): Buffer;
  };
  blobText?: {
    fromDb(buffer: Buffer, context: DecodeContext): string;
    toDb(value: string, context: EncodeContext): Buffer;
  };
}

export type DecodeErrorMode = 'replace' | 'strict';

export interface TextCodecOptions {
  /** Connection charset (lc_ctype) name, e.g. "UTF8" or "NONE". */
  connectionCharset: string;
  /** How to decode text when the effective charset is NONE (e.g. "win1252"). */
  charsetNoneEncoding?: string;
  transcodeAdapter?: FirebirdTranscodeAdapter;
  /** "REL.FIELD" or "FIELD" → charset name override. */
  charsetOverrides?: Record<string, string>;
  onDecodeError?: DecodeErrorMode;
}

export interface ColumnTextMeta {
  /** Firebird charset id from column metadata (sqlsubtype & 0xff for text). */
  charsetId: number;
  fieldName?: string;
  relationName?: string;
  sqlType?: string;
  blobSubtype?: number;
}

export interface TextCodec {
  /** Decode bytes from the wire to a JS value. Returns Buffer for OCTETS. */
  decode(buf: Buffer): string | Buffer;
  /** Encode a JS string for the wire. */
  encode(value: string): Buffer;
}

function iconvDecode(buf: Buffer, encoding: string, mode: DecodeErrorMode): string {
  const s = iconv.decode(buf, encoding);
  if (mode === 'strict' && s.includes('�') && !buf.includes(0xef)) {
    throw new Error(`Invalid byte sequence for encoding ${encoding}`);
  }
  return s;
}

/**
 * Resolves the codec for one column/parameter ONCE (at prepare time) so row
 * decoding has zero per-cell branching. Resolution order (see plans/charset-none.md):
 * transcodeAdapter → charsetOverrides → declared column charset →
 * charsetNoneEncoding (when effective charset is NONE) → connection charset.
 */
export function resolveTextCodec(meta: ColumnTextMeta, opts: TextCodecOptions): TextCodec {
  const declared: CharsetInfo | undefined = CHARSETS_BY_ID.get(meta.charsetId);
  const isBlobText = meta.blobSubtype === 1;

  // 1. Adapter has absolute priority.
  const adapter = isBlobText ? (opts.transcodeAdapter?.blobText ?? opts.transcodeAdapter?.text) : opts.transcodeAdapter?.text;
  if (adapter) {
    const dctx: DecodeContext = {
      charset: declared?.name ?? 'NONE',
      declaredCharset: declared?.name,
      fieldName: meta.fieldName,
      relationName: meta.relationName,
      sqlType: meta.sqlType,
      blobSubtype: meta.blobSubtype,
    };
    const ectx: EncodeContext = {
      charset: declared?.name ?? 'NONE',
      declaredCharset: declared?.name,
      sqlType: meta.sqlType,
      blobSubtype: meta.blobSubtype,
    };
    return {
      decode: (buf) => adapter.fromDb(buf, dctx),
      encode: (v) => adapter.toDb(v, ectx),
    };
  }

  // 2. Field-level override.
  const overrides = opts.charsetOverrides;
  if (overrides && meta.fieldName) {
    const qualified = meta.relationName ? `${meta.relationName}.${meta.fieldName}` : undefined;
    const overrideName = (qualified && overrides[qualified]) || overrides[meta.fieldName];
    if (overrideName) return codecFor(resolveCharset(overrideName), opts);
  }

  // 3. OCTETS → raw buffers, always.
  if (meta.charsetId === CS_OCTETS) {
    return { decode: (buf) => Buffer.from(buf), encode: () => { throw new Error('Cannot encode string into OCTETS column; pass a Buffer'); } };
  }

  // 4. Declared charset when meaningful; NONE falls through to the configured strategy.
  let effective: CharsetInfo | undefined = declared && declared.id !== CS_NONE ? declared : undefined;

  if (!effective) {
    // Effective charset is NONE (or unknown): honor charsetNoneEncoding.
    if (opts.charsetNoneEncoding) {
      const enc = opts.charsetNoneEncoding;
      const mode = opts.onDecodeError ?? 'replace';
      return {
        decode: (buf) => iconvDecode(buf, enc, mode),
        encode: (v) => iconv.encode(v, enc),
      };
    }
    // No strategy configured: NONE decodes byte-preserving as latin1.
    const connection = opts.connectionCharset ? resolveCharset(opts.connectionCharset) : undefined;
    effective = connection && connection.id !== CS_NONE ? connection : resolveCharset('ISO8859_1');
  }

  return codecFor(effective, opts);
}

function codecFor(cs: CharsetInfo, opts: TextCodecOptions): TextCodec {
  if (cs.binary) {
    return { decode: (buf) => Buffer.from(buf), encode: () => { throw new Error('Cannot encode string into OCTETS; pass a Buffer'); } };
  }
  if (cs.node) {
    const enc = cs.node;
    return { decode: (buf) => buf.toString(enc), encode: (v) => Buffer.from(v, enc) };
  }
  const enc = cs.iconv;
  if (!enc || !iconv.encodingExists(enc)) {
    throw new Error(`No decoder available for Firebird charset ${cs.name}`);
  }
  const mode = opts.onDecodeError ?? 'replace';
  return {
    decode: (buf) => iconvDecode(buf, enc, mode),
    encode: (v) => iconv.encode(v, enc),
  };
}
