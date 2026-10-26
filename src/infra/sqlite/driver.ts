// The only file that knows about node:sqlite. Swapping the driver (e.g. to better-sqlite3)
// means reimplementing openSqliteDatabase; nothing else imports the library.
// Rules that keep the swap to one file: positional `?` parameters only, rows typed as
// unknown (parsed by mappers), and transactions issued as plain SQL.
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type SqlValue = string | number | bigint | null;
export type SqlRow = Readonly<Record<string, unknown>>;
export type TransactionMode = 'immediate' | 'deferred';

export interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  get(sql: string, params?: readonly SqlValue[]): SqlRow | undefined;
  all(sql: string, params?: readonly SqlValue[]): SqlRow[];
  /**
   * BEGIN <mode> ... COMMIT; ROLLBACK and rethrow if `fn` throws.
   * `fn` must be synchronous: awaiting inside a write transaction would let other work interleave.
   */
  transaction<T>(mode: TransactionMode, fn: () => T): T;
  close(): void;
}

/** `location` is a file path or ':memory:'. */
export function openSqliteDatabase(location: string): SqlDatabase {
  const database = new DatabaseSync(location);
  const statementCache = new Map<string, StatementSync>();
  let isInTransaction = false;

  function prepare(sql: string): StatementSync {
    const cached = statementCache.get(sql);
    if (cached !== undefined) {
      return cached;
    }
    const statement = database.prepare(sql);
    statementCache.set(sql, statement);
    return statement;
  }

  function rollbackAndRethrow(originalError: unknown): never {
    try {
      database.exec('ROLLBACK');
    } catch (rollbackError: unknown) {
      throw new AggregateError([originalError, rollbackError], 'Transaction failed and its rollback also failed');
    }
    throw originalError;
  }

  return {
    exec(sql) {
      database.exec(sql);
    },

    run(sql, params = []) {
      const result = prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    },

    get(sql, params = []) {
      return prepare(sql).get(...params);
    },

    all(sql, params = []) {
      return prepare(sql).all(...params);
    },

    transaction(mode, fn) {
      if (isInTransaction) {
        throw new Error('Nested transactions are not supported');
      }
      database.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
      isInTransaction = true;
      try {
        const result = fn();
        if (isPromiseLike(result)) {
          throw new Error('Transaction callback must be synchronous; it returned a promise');
        }
        database.exec('COMMIT');
        return result;
      } catch (error: unknown) {
        return rollbackAndRethrow(error);
      } finally {
        isInTransaction = false;
      }
    },

    close() {
      statementCache.clear();
      database.close();
    },
  };
}

function isPromiseLike(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function';
}
