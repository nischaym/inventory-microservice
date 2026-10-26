import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_HASH_VERSION } from '../../src/domain/feed-hash.js';
import { once } from 'node:events';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { reconcile } from '../../src/domain/reconcile.js';
import { accord, asActive, asRemoved, civicMarch15 } from '../fixtures/brief-example.js';
import { openRepository } from '../helpers/sqlite-repository.js';
import { createTempDirectory } from '../helpers/temp-directory.js';

const DEALERSHIP = 'LHS-1042';

describe('SqliteInventoryRepository on a database file', () => {
  let tempDirectory: ReturnType<typeof createTempDirectory>;
  let databasePath: string;

  beforeEach(() => {
    tempDirectory = createTempDirectory();
    databasePath = join(tempDirectory.path, 'inventory.db');
  });

  afterEach(() => {
    tempDirectory.cleanup();
  });

  test('NFR-2: data survives closing and reopening the file', () => {
    const first = openRepository(databasePath);
    first.repository.inTransaction((transaction) => {
      transaction.applyChanges(DEALERSHIP, reconcile([], [civicMarch15, accord], '2026-03-15'));
      transaction.recordFeed(DEALERSHIP, '2026-03-15', 'hash-a');
    });
    first.repository.inTransaction((transaction) => {
      transaction.applyChanges(DEALERSHIP, reconcile(transaction.loadVehicles(DEALERSHIP), [civicMarch15], '2026-03-16'));
      transaction.recordFeed(DEALERSHIP, '2026-03-16', 'hash-b');
    });
    first.db.close();

    const reopened = openRepository(databasePath);
    try {
      assert.deepEqual(
        reopened.repository.inTransaction((transaction) => transaction.loadVehicles(DEALERSHIP)),
        [asRemoved(accord, '2026-03-16'), asActive(civicMarch15)],
      );
      assert.deepEqual(reopened.repository.listDealerships(), [
        { dealershipId: DEALERSHIP, latestFeedDate: '2026-03-16', activeVehicleCount: 1 },
      ]);
      assert.deepEqual(
        reopened.repository.inTransaction((transaction) => transaction.findFeed(DEALERSHIP, '2026-03-15')),
        { contentHash: 'hash-a', hashVersion: FEED_HASH_VERSION },
      );
    } finally {
      reopened.db.close();
    }
  });

  test('D-5: while one connection holds the write transaction, another cannot start one and fails after busy_timeout', () => {
    const holder = openRepository(databasePath);
    const contender = openRepository(databasePath);
    contender.db.exec('PRAGMA busy_timeout = 100');
    try {
      holder.repository.inTransaction((transaction) => {
        transaction.recordFeed(DEALERSHIP, '2026-03-15', 'hash-a');

        const startedAt = performance.now();
        assert.throws(() => contender.repository.inTransaction(() => undefined), /database is locked/);
        assert.ok(performance.now() - startedAt >= 90, 'contender should wait for busy_timeout before failing');
      });

      // Once the holder commits, the contender proceeds and sees the committed write.
      assert.equal(
        contender.repository.inTransaction((transaction) => transaction.latestFeedDate(DEALERSHIP)),
        '2026-03-15',
      );
    } finally {
      holder.db.close();
      contender.db.close();
    }
  });

  test('D-5: a writer waits for another connection to commit, then proceeds on the committed state', async () => {
    const { db, repository } = openRepository(databasePath);
    // A second thread takes the write lock, writes a feed, holds the lock for 300 ms, then commits.
    const lockHolder = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData.databasePath);
      db.exec('BEGIN IMMEDIATE');
      db.prepare('INSERT INTO feeds (dealership_id, feed_date, content_hash, hash_version) VALUES (?, ?, ?, ?)').run('${DEALERSHIP}', '2026-03-15', 'from-worker', 1);
      parentPort.postMessage('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      db.exec('COMMIT');
      db.close();
      `,
      { eval: true, workerData: { databasePath } },
    );
    try {
      await once(lockHolder, 'message');

      const startedAt = performance.now();
      const latestSeenByWaiter = repository.inTransaction((transaction) => transaction.latestFeedDate(DEALERSHIP));
      const waitedMs = performance.now() - startedAt;

      assert.equal(latestSeenByWaiter, '2026-03-15');
      assert.ok(waitedMs >= 150, `expected to wait for the lock holder, waited ${waitedMs.toFixed(0)} ms`);
    } finally {
      await once(lockHolder, 'exit');
      db.close();
    }
  });
});
