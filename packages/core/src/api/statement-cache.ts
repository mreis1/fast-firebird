import { FreeStatement, StmtType } from '../protocol/constants.js';
import { freeStatement, type PreparedStatementInfo } from '../protocol/statement.js';
import type { WireConnection } from '../protocol/wire.js';

/**
 * Per-attachment LRU cache of prepared statements keyed by exact SQL text.
 *
 * Firebird DSQL statements belong to the attachment, not to a transaction,
 * so a cached handle can be re-executed under any later transaction. A cache
 * hit turns a query into a single round trip (execute + first fetch batch
 * piggybacked). Evicted/cleared handles are dropped lazily (deferred
 * op_free_statement rides with the next packet — zero extra round trips).
 */
export class StatementCache {
  private readonly map = new Map<string, PreparedStatementInfo>();

  constructor(
    private readonly wire: WireConnection,
    readonly capacity: number,
  ) {}

  static isCacheable(stmtType: StmtType): boolean {
    switch (stmtType) {
      case StmtType.select:
      case StmtType.select_for_upd:
      case StmtType.insert:
      case StmtType.update:
      case StmtType.delete:
      case StmtType.exec_procedure:
        return true;
      default:
        // DDL and transaction-control statements are never cached.
        return false;
    }
  }

  get(sql: string): PreparedStatementInfo | undefined {
    const info = this.map.get(sql);
    if (info) {
      // Refresh LRU position.
      this.map.delete(sql);
      this.map.set(sql, info);
    }
    return info;
  }

  put(sql: string, info: PreparedStatementInfo): void {
    if (this.capacity <= 0) return;
    const existing = this.map.get(sql);
    if (existing && existing !== info) {
      freeStatement(this.wire, existing.handle, FreeStatement.DSQL_drop);
    }
    this.map.delete(sql);
    this.map.set(sql, info);
    while (this.map.size > this.capacity) {
      const [oldest, oldInfo] = this.map.entries().next().value as [string, PreparedStatementInfo];
      this.map.delete(oldest);
      freeStatement(this.wire, oldInfo.handle, FreeStatement.DSQL_drop);
    }
  }

  /**
   * Remove one entry and free its server handle (deferred). Safe even for
   * stale handles — errors from deferred frees are swallowed by design.
   */
  remove(sql: string): void {
    const info = this.map.get(sql);
    if (info) {
      this.map.delete(sql);
      freeStatement(this.wire, info.handle, FreeStatement.DSQL_drop);
    }
  }

  /** Drop everything (e.g. after DDL — column formats may have changed). */
  clear(): void {
    for (const info of this.map.values()) {
      freeStatement(this.wire, info.handle, FreeStatement.DSQL_drop);
    }
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
