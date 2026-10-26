import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { openSqliteDatabase, type SqlDatabase, type SqlValue } from '../../src/infra/sqlite/driver.js';
import { initializeSchema } from '../../src/infra/sqlite/schema.js';
import { createTempDirectory } from '../helpers/temp-directory.js';

const VEHICLE_COLUMNS =
  'dealership_id, vin, stock_number, condition, lot_status, year, make, model, trim, price, mileage, stocked_on, status, removed_on';

function vehicleRow(overrides: Partial<Record<string, SqlValue>> = {}): SqlValue[] {
  const row: Record<string, SqlValue> = {
    dealership_id: 'LHS-1042',
    vin: '2HGFE1F71NH304352',
    stock_number: 'H2401',
    condition: 'used',
    lot_status: 'on_lot',
    year: 2022,
    make: 'Honda',
    model: 'Civic',
    trim: 'EX',
    price: 18495,
    mileage: 41850,
    stocked_on: '2026-02-03',
    status: 'active',
    removed_on: null,
    ...overrides,
  };
  return VEHICLE_COLUMNS.split(', ').map((column) => row[column] ?? null);
}

function insertVehicle(db: SqlDatabase, overrides: Partial<Record<string, SqlValue>> = {}): void {
  db.run(`INSERT INTO vehicles (${VEHICLE_COLUMNS}) VALUES (${'?, '.repeat(13)}?)`, vehicleRow(overrides));
}

describe('initializeSchema', () => {
  let db: SqlDatabase;

  beforeEach(() => {
    db = openSqliteDatabase(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  test('is idempotent: running it again on an initialized database keeps data', () => {
    insertVehicle(db);
    initializeSchema(db);
    assert.equal(db.get('SELECT COUNT(*) AS total FROM vehicles')?.['total'], 1);
  });

  test('accepts a valid active row and a valid removed row', () => {
    insertVehicle(db);
    insertVehicle(db, { vin: '1HGCY1F39TA098765', status: 'removed', removed_on: '2026-03-16' });
    assert.equal(db.get('SELECT COUNT(*) AS total FROM vehicles')?.['total'], 2);
  });

  test('rejects an active row with a removed_on date', () => {
    assert.throws(() => insertVehicle(db, { status: 'active', removed_on: '2026-03-16' }), /CHECK constraint/);
  });

  test('rejects a removed row without a removed_on date', () => {
    assert.throws(() => insertVehicle(db, { status: 'removed', removed_on: null }), /CHECK constraint/);
  });

  test('rejects unknown enum values, non-positive price and negative mileage', () => {
    assert.throws(() => insertVehicle(db, { condition: 'cpo' }), /CHECK constraint/);
    assert.throws(() => insertVehicle(db, { lot_status: 'sold' }), /CHECK constraint/);
    assert.throws(() => insertVehicle(db, { status: 'archived' }), /CHECK constraint/);
    assert.throws(() => insertVehicle(db, { price: 0 }), /CHECK constraint/);
    assert.throws(() => insertVehicle(db, { mileage: -1 }), /CHECK constraint/);
  });

  test('STRICT tables reject values of the wrong type', () => {
    assert.throws(() => insertVehicle(db, { price: 'cheap' }), /cannot store TEXT value in INTEGER column/);
  });

  test('a VIN is unique per dealership but may repeat across dealerships', () => {
    insertVehicle(db);
    assert.throws(() => insertVehicle(db), /UNIQUE constraint/);
    insertVehicle(db, { dealership_id: 'OTHER-1' });
  });

  test('one feeds row per dealership and feed date', () => {
    const insertFeed = 'INSERT INTO feeds (dealership_id, feed_date, content_hash, hash_version) VALUES (?, ?, ?, ?)';
    db.run(insertFeed, ['LHS-1042', '2026-03-15', 'abc', 1]);
    assert.throws(() => db.run(insertFeed, ['LHS-1042', '2026-03-15', 'def', 1]), /UNIQUE constraint/);
  });

  test('hash_version has no default, so a feed row cannot be written without one', () => {
    assert.throws(
      () => db.run('INSERT INTO feeds (dealership_id, feed_date, content_hash) VALUES (?, ?, ?)', ['LHS-1042', '2026-03-15', 'abc']),
      /NOT NULL constraint failed: feeds.hash_version/,
    );
  });
});

describe('initializeSchema connection settings (file database)', () => {
  test('enables WAL, synchronous=FULL and a 5 s busy timeout', () => {
    const tempDirectory = createTempDirectory();
    const db = openSqliteDatabase(join(tempDirectory.path, 'inventory.db'));
    try {
      initializeSchema(db);
      assert.equal(db.get('PRAGMA journal_mode')?.['journal_mode'], 'wal');
      assert.equal(db.get('PRAGMA synchronous')?.['synchronous'], 2); // 2 = FULL
      assert.equal(db.get('PRAGMA busy_timeout')?.['timeout'], 5000);
    } finally {
      db.close();
      tempDirectory.cleanup();
    }
  });
});
