import { Op, Tpb } from './constants.js';
import { ParamBuffer } from './buffers.js';
import type { WireConnection } from './wire.js';

export type IsolationLevel =
  | 'snapshot' // concurrency (repeatable read) — Firebird default
  | 'serializable' // consistency
  | 'readCommitted' // read_committed + rec_version
  | 'readCommittedNoRecVersion';

/**
 * Driver default lock wait, in seconds. Firebird's native default is WAIT
 * with NO timeout — a blocked statement (a lock conflict, or DDL against
 * metadata pinned by any prepared statement anywhere) waits forever, which
 * reads as a hang. The driver defaults to a 10s timeout instead: blocked
 * work fails with a clear "lock time-out on wait transaction" error. Opt
 * back into Firebird's unbounded wait explicitly with `wait: true`.
 */
export const DEFAULT_LOCK_TIMEOUT_SECONDS = 10;

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
  /**
   * Lock-wait behavior: number = wait up to that many seconds, then error;
   * `false` = nowait (fail immediately); `true` = wait forever (Firebird's
   * native default). Driver default when unset: **10 seconds**
   * (`DEFAULT_LOCK_TIMEOUT_SECONDS`) — so contention surfaces as a clear
   * lock-timeout error instead of an unbounded hang.
   */
  wait?: boolean | number;
  autoCommit?: boolean;
  /**
   * Client-side behavior, not part of the TPB: when a statement in a
   * read-only transaction fails with "attempted update during read-only
   * transaction", commit and reopen the transaction read-write (same
   * isolation/wait) and replay that statement once. Applies to
   * `tx.query/run/execute`; `queryStream` and prepared statements are not
   * replayed. The upgrade is a real commit + new transaction: the snapshot
   * moves forward and lazy Blob handles from before it become invalid; the
   * transaction stays read-write afterwards (`tx.autoUpgraded` reports it).
   * One-shot `db.query/run/execute` route through the same path, so a
   * read-only `defaultTransaction` upgrades transparently there too.
   * Default: the connection's `autoUpgradeReadOnly` option (false).
   */
  autoUpgradeReadOnly?: boolean;
}

/**
 * Merge a connection's `defaultTransaction` with per-call options: fields the
 * caller sets (non-undefined) win, everything else falls back to the defaults.
 * @internal
 */
export function mergeTransactionOptions(
  defaults: TransactionOptions,
  overrides?: TransactionOptions,
): TransactionOptions {
  const merged: TransactionOptions = { ...defaults };
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

export function buildTpb(opts: TransactionOptions = {}): Buffer {
  const pb = new ParamBuffer(Tpb.version3);
  switch (opts.isolation ?? 'snapshot') {
    case 'snapshot':
      pb.tag(Tpb.concurrency);
      break;
    case 'serializable':
      pb.tag(Tpb.consistency);
      break;
    case 'readCommitted':
      pb.tag(Tpb.read_committed).tag(Tpb.rec_version);
      break;
    case 'readCommittedNoRecVersion':
      pb.tag(Tpb.read_committed).tag(Tpb.no_rec_version);
      break;
  }
  pb.tag(opts.readOnly ? Tpb.read : Tpb.write);
  const wait = opts.wait ?? DEFAULT_LOCK_TIMEOUT_SECONDS;
  if (wait === false) {
    pb.tag(Tpb.nowait);
  } else {
    pb.tag(Tpb.wait);
    if (typeof wait === 'number') pb.int32(Tpb.lock_timeout, wait);
  }
  if (opts.autoCommit) pb.tag(Tpb.autocommit);
  return pb.toBuffer();
}

export async function startTransaction(
  wire: WireConnection,
  dbHandle: number,
  opts?: TransactionOptions,
): Promise<number> {
  wire.writer.int32(Op.transaction).int32(dbHandle).opaque(buildTpb(opts));
  wire.flush();
  return (await wire.readResponse()).handle;
}

export async function commitTransaction(wire: WireConnection, txHandle: number, retain = false): Promise<void> {
  wire.writer.int32(retain ? Op.commit_retaining : Op.commit).int32(txHandle);
  wire.flush();
  await wire.readResponse();
}

export async function rollbackTransaction(wire: WireConnection, txHandle: number, retain = false): Promise<void> {
  wire.writer.int32(retain ? Op.rollback_retaining : Op.rollback).int32(txHandle);
  wire.flush();
  await wire.readResponse();
}
