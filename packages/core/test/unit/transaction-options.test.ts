import { describe, expect, it } from 'vitest';
import { buildTpb, mergeTransactionOptions } from '../../src/protocol/transaction.js';
import { Tpb } from '../../src/protocol/constants.js';

/** The driver-default lock timeout clumplet: wait + lock_timeout 10 (LE int32). */
const WAIT_10 = [Tpb.wait, Tpb.lock_timeout, 4, 10, 0, 0, 0];

describe('buildTpb', () => {
  it('defaults to snapshot / read-write / wait with a 10s lock timeout', () => {
    expect([...buildTpb()]).toEqual([Tpb.version3, Tpb.concurrency, Tpb.write, ...WAIT_10]);
  });

  it('wait: true opts back into Firebird-native unbounded wait (no timeout)', () => {
    expect([...buildTpb({ wait: true })]).toEqual([Tpb.version3, Tpb.concurrency, Tpb.write, Tpb.wait]);
  });

  it('readCommitted emits read_committed + rec_version', () => {
    expect([...buildTpb({ isolation: 'readCommitted' })]).toEqual([
      Tpb.version3,
      Tpb.read_committed,
      Tpb.rec_version,
      Tpb.write,
      ...WAIT_10,
    ]);
  });

  it('readCommittedNoRecVersion emits no_rec_version', () => {
    expect([...buildTpb({ isolation: 'readCommittedNoRecVersion' })]).toEqual([
      Tpb.version3,
      Tpb.read_committed,
      Tpb.no_rec_version,
      Tpb.write,
      ...WAIT_10,
    ]);
  });

  it('numeric wait emits wait + lock_timeout clumplet (LE int32)', () => {
    expect([...buildTpb({ wait: 5 })]).toEqual([
      Tpb.version3,
      Tpb.concurrency,
      Tpb.write,
      Tpb.wait,
      Tpb.lock_timeout,
      4,
      5,
      0,
      0,
      0,
    ]);
  });

  it('wait: false emits nowait', () => {
    expect([...buildTpb({ wait: false })]).toEqual([Tpb.version3, Tpb.concurrency, Tpb.write, Tpb.nowait]);
  });

  it('readOnly emits read', () => {
    expect([...buildTpb({ readOnly: true })]).toEqual([Tpb.version3, Tpb.concurrency, Tpb.read, ...WAIT_10]);
  });

  it('the node-firebird2 high-concurrency pattern round-trips', () => {
    expect([...buildTpb({ isolation: 'readCommitted', readOnly: true, wait: 5 })]).toEqual([
      Tpb.version3,
      Tpb.read_committed,
      Tpb.rec_version,
      Tpb.read,
      Tpb.wait,
      Tpb.lock_timeout,
      4,
      5,
      0,
      0,
      0,
    ]);
  });
});

describe('mergeTransactionOptions', () => {
  const defaults = { isolation: 'readCommitted', readOnly: true, wait: 5, autoUpgradeReadOnly: true } as const;

  it('no overrides → a copy of the defaults', () => {
    const merged = mergeTransactionOptions(defaults);
    expect(merged).toEqual(defaults);
    expect(merged).not.toBe(defaults);
  });

  it('per-call fields win; unset fields keep the defaults', () => {
    expect(mergeTransactionOptions(defaults, { readOnly: false, wait: false })).toEqual({
      isolation: 'readCommitted',
      readOnly: false,
      wait: false,
      autoUpgradeReadOnly: true,
    });
  });

  it('explicit undefined does not clobber a default', () => {
    expect(mergeTransactionOptions(defaults, { isolation: undefined })).toEqual(defaults);
  });

  it('empty defaults leave per-call options untouched', () => {
    expect(mergeTransactionOptions({}, { isolation: 'snapshot' })).toEqual({ isolation: 'snapshot' });
    expect(mergeTransactionOptions({})).toEqual({});
  });

  it('does not mutate either input', () => {
    const d = { ...defaults };
    const o = { wait: 10 as const };
    mergeTransactionOptions(d, o);
    expect(d).toEqual(defaults);
    expect(o).toEqual({ wait: 10 });
  });
});
