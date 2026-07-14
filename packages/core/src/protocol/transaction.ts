import { Op, Tpb } from './constants.js';
import { ParamBuffer } from './buffers.js';
import type { WireConnection } from './wire.js';

export type IsolationLevel =
  | 'snapshot' // concurrency (repeatable read) — Firebird default
  | 'serializable' // consistency
  | 'readCommitted' // read_committed + rec_version
  | 'readCommittedNoRecVersion';

export interface TransactionOptions {
  isolation?: IsolationLevel;
  readOnly?: boolean;
  /** true (default) = wait for locks; number = lock timeout seconds; false = nowait. */
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
   * Default: the connection's `autoUpgradeReadOnly` option (false).
   */
  autoUpgradeReadOnly?: boolean;
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
  const wait = opts.wait ?? true;
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
