import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqliteDatabase, type SqlDatabase } from '../../src/infra/sqlite/driver.js';

describe('SqlDatabase (node:sqlite driver)', () => {
  let db: SqlDatabase;

  beforeEach(() => {
    db = openSqliteDatabase(':memory:');
    db.exec('CREATE TABLE items (name TEXT PRIMARY KEY, quantity INTEGER NOT NULL CHECK (quantity >= 0)) STRICT');
  });

  afterEach(() => {
    db.close();
  });

  function countItems(): unknown {
    return db.get('SELECT COUNT(*) AS total FROM items')?.['total'];
  }

  test('run binds positional parameters and reports changed rows', () => {
    assert.deepEqual(db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]), { changes: 1 });
    assert.deepEqual(db.run('UPDATE items SET quantity = ? WHERE name = ?', [6, 'missing']), { changes: 0 });
  });

  test('get returns one row as a plain record, or undefined when there is none', () => {
    db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);

    assert.deepEqual({ ...db.get('SELECT name, quantity FROM items WHERE name = ?', ['bolt']) }, { name: 'bolt', quantity: 5 });
    assert.equal(db.get('SELECT name FROM items WHERE name = ?', ['nut']), undefined);
  });

  test('all returns every row in query order', () => {
    db.run('INSERT INTO items VALUES (?, ?)', ['nut', 2]);
    db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);

    const rows = db.all('SELECT name FROM items ORDER BY name').map((row) => row['name']);
    assert.deepEqual(rows, ['bolt', 'nut']);
  });

  test('null parameters round-trip as null', () => {
    db.exec('CREATE TABLE notes (body TEXT) STRICT');
    db.run('INSERT INTO notes VALUES (?)', [null]);
    assert.equal(db.get('SELECT body FROM notes')?.['body'], null);
  });

  test('transaction commits and returns the callback result', () => {
    const result = db.transaction('immediate', () => {
      db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(countItems(), 1);
  });

  test('transaction rolls back every write and rethrows the original error', () => {
    const failure = new Error('boom');

    assert.throws(
      () =>
        db.transaction('immediate', () => {
          db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);
          throw failure;
        }),
      (thrown) => thrown === failure,
    );
    assert.equal(countItems(), 0);
  });

  test('transaction rolls back when a statement violates a constraint midway', () => {
    assert.throws(() =>
      db.transaction('deferred', () => {
        db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);
        db.run('INSERT INTO items VALUES (?, ?)', ['nut', -1]);
      }),
    );
    assert.equal(countItems(), 0);
  });

  test('the connection is usable for a new transaction after a rollback', () => {
    assert.throws(() =>
      db.transaction('immediate', () => {
        throw new Error('first attempt fails');
      }),
    );
    db.transaction('immediate', () => db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]));
    assert.equal(countItems(), 1);
  });

  test('nested transactions are rejected and the outer one rolls back', () => {
    assert.throws(
      () =>
        db.transaction('immediate', () => {
          db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);
          db.transaction('immediate', () => undefined);
        }),
      /nested/i,
    );
    assert.equal(countItems(), 0);
  });

  test('an async callback is rejected and rolled back, since awaiting inside BEGIN IMMEDIATE breaks serialisation', async () => {
    assert.throws(
      () =>
        db.transaction('immediate', async () => {
          db.run('INSERT INTO items VALUES (?, ?)', ['bolt', 5]);
        }),
      /synchronous/i,
    );
    assert.equal(countItems(), 0);
  });

  test('using a closed database throws', () => {
    const closedDb = openSqliteDatabase(':memory:');
    closedDb.close();
    assert.throws(() => closedDb.get('SELECT 1'));
  });
});
