import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlDatabase } from '../../src/infra/sqlite/driver.js';
import type { SqliteInventoryRepository } from '../../src/infra/sqlite/repository.js';
import { FEED_HASH_VERSION } from '../../src/domain/feed-hash.js';
import { reconcile, type ReconcileResult } from '../../src/domain/reconcile.js';
import type { VehicleData } from '../../src/domain/vehicle.js';
import { accord, asActive, asRemoved, civicMarch15, civicMarch16, crv, pilot } from '../fixtures/brief-example.js';
import { openRepository } from '../helpers/sqlite-repository.js';

const DEALERSHIP = 'LHS-1042';

function noChanges(feedDate: string): ReconcileResult {
  return { feedDate, added: [], updated: [], reactivated: [], unchangedVins: [], removedVins: [] };
}

describe('SqliteInventoryRepository write side (FeedTransaction)', () => {
  let db: SqlDatabase;
  let repository: SqliteInventoryRepository;

  beforeEach(() => {
    ({ db, repository } = openRepository());
  });

  afterEach(() => {
    db.close();
  });

  /** Applies one snapshot the way IngestFeed will: reconcile against stored state, write, record. */
  function applySnapshot(feedDate: string, vehicles: readonly VehicleData[], dealershipId = DEALERSHIP): void {
    repository.inTransaction((transaction) => {
      const changes = reconcile(transaction.loadVehicles(dealershipId), vehicles, feedDate);
      transaction.applyChanges(dealershipId, changes);
      transaction.recordFeed(dealershipId, feedDate, `hash-${feedDate}`);
    });
  }

  function loadVehicles(dealershipId = DEALERSHIP) {
    return repository.inTransaction((transaction) => transaction.loadVehicles(dealershipId));
  }

  test('inTransaction returns the callback result', () => {
    assert.equal(
      repository.inTransaction(() => 42),
      42,
    );
  });

  test('round-trips every field, including trim = null', () => {
    const noTrimCrv = { ...crv, trim: null };
    applySnapshot('2026-03-15', [civicMarch15, noTrimCrv]);

    assert.deepEqual(loadVehicles(), [asActive(civicMarch15), asActive(noTrimCrv)]);
  });

  test('stores VINs upper-cased so later lookups match', () => {
    applySnapshot('2026-03-15', [{ ...crv, vin: ' 5j6rs4h84tl012345 ' }]);
    assert.deepEqual(
      loadVehicles().map((vehicle) => vehicle.vin),
      [crv.vin],
    );
  });

  test('brief March 15 -> 16 progression: update, keep, add, remove', () => {
    applySnapshot('2026-03-15', [civicMarch15, crv, accord]);
    applySnapshot('2026-03-16', [{ ...civicMarch16, vin: '2hgfe1f71nh304352' }, crv, pilot]);

    assert.deepEqual(loadVehicles(), [
      asRemoved(accord, '2026-03-16'),
      asActive(civicMarch16),
      asActive(pilot),
      asActive(crv),
    ]);
  });

  test('reactivation replaces every field and clears removedOn', () => {
    applySnapshot('2026-03-15', [accord]);
    applySnapshot('2026-03-16', []);
    const relisted = { ...accord, price: 29990, stockNumber: 'H2500', stockedOn: '2026-03-20' };
    applySnapshot('2026-03-20', [relisted]);

    assert.deepEqual(loadVehicles(), [asActive(relisted)]);
  });

  test('an already-removed vehicle keeps its first removedOn across later feeds', () => {
    applySnapshot('2026-03-15', [accord, crv]);
    applySnapshot('2026-03-16', [crv]);
    applySnapshot('2026-03-17', [crv]);

    assert.deepEqual(loadVehicles(), [asRemoved(accord, '2026-03-16'), asActive(crv)]);
  });

  test('latestFeedDate and findFeed reflect recorded feeds', () => {
    repository.inTransaction((transaction) => {
      assert.equal(transaction.latestFeedDate(DEALERSHIP), undefined);
      transaction.recordFeed(DEALERSHIP, '2026-03-16', 'hash-b');
      transaction.recordFeed(DEALERSHIP, '2026-03-15', 'hash-a');

      assert.equal(transaction.latestFeedDate(DEALERSHIP), '2026-03-16');
      assert.deepEqual(transaction.findFeed(DEALERSHIP, '2026-03-15'), { contentHash: 'hash-a', hashVersion: FEED_HASH_VERSION });
      assert.equal(transaction.findFeed(DEALERSHIP, '2026-03-14'), undefined);
      assert.equal(transaction.latestFeedDate('OTHER-1'), undefined);
    });
  });

  test('recordFeed stores the current FEED_HASH_VERSION next to the hash', () => {
    applySnapshot('2026-03-15', [crv]);
    // node:sqlite rows have a null prototype; spread them so deepStrictEqual compares values only.
    assert.deepEqual(db.all('SELECT feed_date, content_hash, hash_version FROM feeds').map((row) => ({ ...row })), [
      { feed_date: '2026-03-15', content_hash: 'hash-2026-03-15', hash_version: FEED_HASH_VERSION },
    ]);
  });

  test('recording the same feed date twice fails', () => {
    applySnapshot('2026-03-15', [crv]);
    assert.throws(() => repository.inTransaction((transaction) => transaction.recordFeed(DEALERSHIP, '2026-03-15', 'x')));
  });

  test('a feed for one dealership leaves another untouched; the same VIN coexists in both', () => {
    applySnapshot('2026-03-15', [civicMarch15, crv], 'OTHER-1');
    applySnapshot('2026-03-15', [crv]);
    applySnapshot('2026-03-16', []);

    assert.deepEqual(loadVehicles('OTHER-1'), [asActive(civicMarch15), asActive(crv)]);
    assert.deepEqual(loadVehicles(), [asRemoved(crv, '2026-03-16')]);
  });

  test('FR-9: a write failing midway rolls back vehicles and feeds; a first feed creates no dealership', () => {
    const invalidPrice = { ...pilot, price: 0 };
    const changes = { ...noChanges('2026-03-15'), added: [civicMarch15, invalidPrice] };

    assert.throws(
      () =>
        repository.inTransaction((transaction) => {
          transaction.recordFeed(DEALERSHIP, '2026-03-15', 'hash');
          transaction.applyChanges(DEALERSHIP, changes);
        }),
      /CHECK constraint/,
    );
    assert.deepEqual(loadVehicles(), []);
    assert.equal(
      repository.inTransaction((transaction) => transaction.latestFeedDate(DEALERSHIP)),
      undefined,
    );
  });

  test('FR-9: a failure after writes on an existing dealership restores the previous state exactly', () => {
    applySnapshot('2026-03-15', [civicMarch15, crv, accord]);
    const before = loadVehicles();

    assert.throws(() =>
      repository.inTransaction((transaction) => {
        const changes = reconcile(transaction.loadVehicles(DEALERSHIP), [civicMarch16, pilot], '2026-03-16');
        transaction.applyChanges(DEALERSHIP, changes);
        transaction.recordFeed(DEALERSHIP, '2026-03-16', 'hash');
        throw new Error('simulated failure after all writes');
      }),
    );
    assert.deepEqual(loadVehicles(), before);
    assert.equal(
      repository.inTransaction((transaction) => transaction.latestFeedDate(DEALERSHIP)),
      '2026-03-15',
    );
  });

  test('applyChanges refuses changes that do not match stored state instead of writing silently', () => {
    applySnapshot('2026-03-15', [crv]);
    assert.throws(
      () => repository.inTransaction((transaction) => transaction.applyChanges(DEALERSHIP, { ...noChanges('2026-03-16'), added: [crv] })),
      /UNIQUE constraint/,
    );
    assert.throws(
      () => repository.inTransaction((transaction) => transaction.applyChanges(DEALERSHIP, { ...noChanges('2026-03-16'), updated: [pilot] })),
      /expected to update 1 vehicle/,
    );
    assert.throws(
      () => repository.inTransaction((transaction) => transaction.applyChanges(DEALERSHIP, { ...noChanges('2026-03-16'), reactivated: [crv] })),
      /expected to update 1 vehicle/,
    );
    assert.throws(
      () => repository.inTransaction((transaction) => transaction.applyChanges(DEALERSHIP, { ...noChanges('2026-03-16'), removedVins: [pilot.vin] })),
      /expected to update 1 vehicle/,
    );
    assert.deepEqual(loadVehicles(), [asActive(crv)]);
  });

  test('applyChanges refuses to remove an already-removed vehicle, keeping its original removedOn', () => {
    applySnapshot('2026-03-15', [accord]);
    applySnapshot('2026-03-16', []);

    assert.throws(
      () => repository.inTransaction((transaction) => transaction.applyChanges(DEALERSHIP, { ...noChanges('2026-03-20'), removedVins: [accord.vin] })),
      /expected to update 1 vehicle to remove/,
    );
    assert.deepEqual(loadVehicles(), [asRemoved(accord, '2026-03-16')]);
  });
});
