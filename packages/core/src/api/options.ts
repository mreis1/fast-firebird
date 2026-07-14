import type { FirebirdTranscodeAdapter } from '../charset/decoder.js';
import { WireCryptLevel } from '../protocol/constants.js';

export type WireCryptOption = 'enabled' | 'disabled' | 'required';

/**
 * Blob fetch mode: which blob columns come back as lazy `Blob` handles vs
 * eagerly materialized values (text → string a.k.a. memo, binary → Buffer).
 */
export type BlobMode = 'eager' | 'lazy' | 'lazy-binary' | 'lazy-text';

/**
 * Per-column blob configuration: a base mode plus named overrides. Column
 * names match the row key (alias-aware) — bare (`DOC`) or FROM-alias
 * qualified (`A.DOC`), case-insensitive. A column listed in both arrays is a
 * configuration error (throws at query time).
 *
 * ```ts
 * blobs: { default: 'lazy-binary', eager: ['THUMB'], lazy: ['HUGE_XML'] }
 * ```
 */
export interface BlobColumnModes {
  /** Base mode for blob columns not named below. Default 'eager'. */
  default?: BlobMode;
  /** Columns always materialized (string for memos, Buffer for binary). */
  eager?: string[];
  /** Columns always returned as lazy `Blob` handles. */
  lazy?: string[];
}

/** The `blobs` option: a plain mode or the per-column form. */
export type BlobsOption = BlobMode | BlobColumnModes;

/** True when this blobs config can put lazy handles in rows (needs a tx). @internal */
export function blobsMayProduceLazy(opt: BlobsOption): boolean {
  if (typeof opt === 'string') return opt !== 'eager';
  return (opt.default ?? 'eager') !== 'eager' || (opt.lazy?.length ?? 0) > 0;
}

/**
 * Read-ahead for LAZY blobs in `queryStream`: while the consumer processes
 * row N, the driver prefetches upcoming rows' blob contents in background
 * op-lock slices, so `.buffer()/.text()/.stream()` resolve without wire round
 * trips. Purely an optimization — skipped rows, out-of-order reads, or
 * budget-exceeding blobs silently fall back to the on-demand path.
 *
 * - `true` → depth 1, all lazy blob columns
 * - `n` → depth n
 * - `{ columns?, depth?, maxBytes? }` — restrict to named columns; `maxBytes`
 *   bounds prefetched-but-unconsumed memory per stream (default 16 MiB; may
 *   overshoot by at most one blob since sizes aren't known upfront).
 * - `false` → disabled (overrides a connection-level default)
 */
export type BlobReadAheadOption = boolean | number | { columns?: string[]; depth?: number; maxBytes?: number };

/** Normalized read-ahead config. @internal */
export interface ResolvedReadAhead {
  /** Lowercased column names, or null = every lazy blob column. */
  columns: string[] | null;
  depth: number;
  maxBytes: number;
}

const READ_AHEAD_DEFAULT_BYTES = 16 * 1024 * 1024;

/** Normalize a user read-ahead option (undefined/false → null = off). @internal */
export function resolveReadAhead(raw: BlobReadAheadOption | undefined): ResolvedReadAhead | null {
  if (!raw) return null;
  if (raw === true) return { columns: null, depth: 1, maxBytes: READ_AHEAD_DEFAULT_BYTES };
  if (typeof raw === 'number') return { columns: null, depth: Math.max(1, Math.floor(raw)), maxBytes: READ_AHEAD_DEFAULT_BYTES };
  return {
    columns: raw.columns?.map((c) => c.toLowerCase()) ?? null,
    depth: Math.max(1, Math.floor(raw.depth ?? 1)),
    maxBytes: Math.max(65_536, raw.maxBytes ?? READ_AHEAD_DEFAULT_BYTES),
  };
}

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
   * - `{ default?, eager?: [cols], lazy?: [cols] }`: per-column overrides on
   *   top of a base mode (see BlobColumnModes).
   */
  blobs?: BlobsOption;
  /** Default lazy-blob read-ahead for `queryStream` (see BlobReadAheadOption). */
  blobReadAhead?: BlobReadAheadOption;
  /**
   * FB 5.0.2+ (protocol ≥ 19): blobs up to this size (bytes) ride INLINE with
   * the row data — zero extra round trips for small blobs/memos. Clamped to
   * 0–65535; 0 disables. Ignored by older servers. Default 65535.
   */
  maxInlineBlobSize?: number;
  /**
   * Byte budget for received-but-unread inline blobs per connection
   * (mirrors fbclient's blob cache). Overflow is silently dropped — those
   * blobs read via the normal path. Default 10 MiB.
   */
  maxBlobCacheSize?: number;
  blobWriteChunkSize?: number;
  blobReadChunkSize?: number;
  /** Rows requested per fetch round trip. */
  fetchSize?: number;

  /**
   * Default for `TransactionOptions.autoUpgradeReadOnly`: transparently
   * upgrade a read-only transaction to read-write (commit + reopen + replay
   * the failing statement once) when a write is attempted in it. Default
   * false. See `TransactionOptions.autoUpgradeReadOnly` for the semantics.
   */
  autoUpgradeReadOnly?: boolean;

  /**
   * How TIMESTAMP/TIME WITH TIME ZONE columns decode:
   * - 'instant' (default): JS `Date` — the exact UTC instant; the stored
   *   zone id is dropped.
   * - 'zoned': `ZonedDate { date, zone }` — same instant plus the zone
   *   ('Europe/Lisbon' or '+02:30'), round-trippable as a parameter.
   * Connection-level only (column readers are cached per statement).
   */
  timeZones?: 'instant' | 'zoned';

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
  blobs: BlobsOption;
  blobReadAhead: ResolvedReadAhead | null;
  maxInlineBlobSize: number;
  maxBlobCacheSize: number;
  autoUpgradeReadOnly: boolean;
  timeZones: 'instant' | 'zoned';
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
    blobReadAhead: resolveReadAhead(raw.blobReadAhead),
    maxInlineBlobSize: clamp(raw.maxInlineBlobSize ?? 65_535, 0, 65_535),
    maxBlobCacheSize: Math.max(0, raw.maxBlobCacheSize ?? 10 * 1024 * 1024),
    autoUpgradeReadOnly: raw.autoUpgradeReadOnly ?? false,
    timeZones: raw.timeZones ?? 'instant',
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
