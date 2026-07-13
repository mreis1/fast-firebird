import type { FirebirdTranscodeAdapter } from '../charset/decoder.js';
import { WireCryptLevel } from '../protocol/constants.js';

export type WireCryptOption = 'enabled' | 'disabled' | 'required';

/**
 * Blob fetch mode: which blob columns come back as lazy `Blob` handles vs
 * eagerly materialized values (text → string a.k.a. memo, binary → Buffer).
 */
export type BlobMode = 'eager' | 'lazy' | 'lazy-binary' | 'lazy-text';

export interface FirebirdConnectionOptions {
  host?: string;
  port?: number;
  database: string;
  user?: string;
  password?: string;

  role?: string | null;
  /** Connection charset (lc_ctype). Default UTF8. */
  charset?: string;
  /** Compatibility alias for charset. */
  encoding?: string;

  lowercaseKeys?: boolean;
  pageSize?: number;

  connectTimeoutMs?: number;

  wireCrypt?: WireCryptOption;
  /** zlib wire compression (server needs WireCompression=true). Default off. */
  wireCompression?: boolean;
  /** Wire-crypt cipher: 'Arc4' (default), 'ChaCha' or 'ChaCha64' (FB4+). */
  wireCryptPlugin?: 'Arc4' | 'ChaCha' | 'ChaCha64';
  authPlugin?: 'Srp256' | 'Srp' | 'Legacy_Auth' | 'auto';

  blobAsText?: boolean;
  /**
   * Default blob handling.
   * - 'eager' (default): materialize during decode — text blobs (memos)
   *   arrive as strings, binary blobs as Buffers.
   * - 'lazy': every blob column becomes a `Blob` handle.
   * - 'lazy-binary': binary blobs lazy, text blobs (memos) eager — the
   *   file-export sweet spot.
   * - 'lazy-text': text blobs lazy, binary blobs eager.
   */
  blobs?: BlobMode;
  blobWriteChunkSize?: number;
  blobReadChunkSize?: number;
  /** Rows requested per fetch round trip. */
  fetchSize?: number;

  charsetNoneEncoding?: string;
  transcodeAdapter?: FirebirdTranscodeAdapter;
  charsetOverrides?: Record<string, string>;

  /**
   * Prepared statements kept per connection, keyed by SQL text (LRU).
   * A cache hit makes repeat queries a single round trip. 0 disables.
   * Default 64.
   */
  statementCacheSize?: number;

  /** @internal Deterministic SRP ephemeral seed — testing only. */
  srpSeed?: Buffer;
}

/** Legacy node-firebird option names accepted at the boundary. */
export interface LegacyOptionAliases {
  lowercase_keys?: boolean;
  retryConnectionInterval?: number;
  blobChunkSize?: number;
  connectTimeout?: number;
  pluginName?: string;
}

export interface ResolvedOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  role: string | null;
  charset: string;
  lowercaseKeys: boolean;
  pageSize: number;
  connectTimeoutMs: number;
  wireCrypt: WireCryptLevel;
  wireCompression: boolean;
  wireCryptPlugin: string | undefined;
  authPlugin: string | undefined;
  blobAsText: boolean;
  blobs: BlobMode;
  blobWriteChunkSize: number;
  blobReadChunkSize: number;
  fetchSize: number;
  charsetNoneEncoding: string | undefined;
  transcodeAdapter: FirebirdTranscodeAdapter | undefined;
  charsetOverrides: Record<string, string> | undefined;
  statementCacheSize: number;
  srpSeed: Buffer | undefined;
}

const WIRE_CRYPT_MAP: Record<WireCryptOption, WireCryptLevel> = {
  disabled: WireCryptLevel.disabled,
  enabled: WireCryptLevel.enabled,
  required: WireCryptLevel.required,
};

/** Normalizes user options (incl. legacy aliases) into internal options. */
export function resolveOptions(raw: FirebirdConnectionOptions & LegacyOptionAliases): ResolvedOptions {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  return {
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 3050,
    database: raw.database,
    user: raw.user ?? 'SYSDBA',
    password: raw.password ?? 'masterkey',
    role: raw.role ?? null,
    charset: (raw.charset ?? raw.encoding ?? 'UTF8').toUpperCase(),
    lowercaseKeys: raw.lowercaseKeys ?? raw.lowercase_keys ?? false,
    pageSize: raw.pageSize ?? 8192,
    connectTimeoutMs: raw.connectTimeoutMs ?? raw.connectTimeout ?? 10_000,
    wireCrypt: WIRE_CRYPT_MAP[raw.wireCrypt ?? 'enabled'],
    wireCompression: raw.wireCompression ?? false,
    wireCryptPlugin: raw.wireCryptPlugin,
    authPlugin: raw.authPlugin === 'auto' ? undefined : (raw.authPlugin ?? (raw.pluginName as string | undefined)),
    blobAsText: raw.blobAsText ?? false,
    blobs: raw.blobs ?? 'eager',
    // Wire maximum by default — blob throughput is round-trip-bound.
    blobWriteChunkSize: clamp(raw.blobWriteChunkSize ?? raw.blobChunkSize ?? 65_535, 1, 65_535),
    blobReadChunkSize: clamp(raw.blobReadChunkSize ?? 65_535, 1, 65_535),
    fetchSize: clamp(raw.fetchSize ?? 400, 1, 65_535),
    charsetNoneEncoding: raw.charsetNoneEncoding,
    transcodeAdapter: raw.transcodeAdapter,
    charsetOverrides: raw.charsetOverrides,
    statementCacheSize: clamp(raw.statementCacheSize ?? 64, 0, 10_000),
    srpSeed: raw.srpSeed,
  };
}
