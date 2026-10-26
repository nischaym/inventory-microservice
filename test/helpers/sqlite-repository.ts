import { openSqliteDatabase, type SqlDatabase } from '../../src/infra/sqlite/driver.js';
import { SqliteInventoryRepository } from '../../src/infra/sqlite/repository.js';
import { initializeSchema } from '../../src/infra/sqlite/schema.js';

export function openRepository(location = ':memory:'): { db: SqlDatabase; repository: SqliteInventoryRepository } {
  const db = openSqliteDatabase(location);
  initializeSchema(db);
  return { db, repository: new SqliteInventoryRepository(db) };
}
