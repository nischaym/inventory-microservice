import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { IngestFeed } from '../../src/app/ingest-feed.js';
import { InventoryQueries } from '../../src/app/queries.js';
import { NotFoundError } from '../../src/domain/errors.js';
import type { SqlDatabase } from '../../src/infra/sqlite/driver.js';
import { accord, asActive, asRemoved, civicMarch15, civicMarch16, crv, pilot } from '../fixtures/brief-example.js';
import { FixedClock } from '../helpers/fixed-clock.js';
import { openRepository } from '../helpers/sqlite-repository.js';

const DEALERSHIP = 'LHS-1042';

describe('InventoryQueries', () => {
  let db: SqlDatabase;
  let clock: FixedClock;
  let queries: InventoryQueries;

  beforeEach(() => {
    const opened = openRepository();
    db = opened.db;
    clock = new FixedClock('2026-03-16');
    queries = new InventoryQueries(opened.repository, clock);
    const ingestFeed = new IngestFeed(opened.repository, { warn: () => undefined });
    ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-15', vehicles: [civicMarch15, crv, accord] });
    ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-16', vehicles: [civicMarch16, crv, pilot] });
  });

  afterEach(() => {
    db.close();
  });

  describe('daysInInventory (FR-13)', () => {
    test('active vehicles count to today (UTC) from the clock', () => {
      assert.deepEqual(queries.findVehicle(DEALERSHIP, civicMarch16.vin), { ...asActive(civicMarch16), daysInInventory: 41 });
      assert.equal(queries.findVehicle(DEALERSHIP, pilot.vin).daysInInventory, 0);
    });

    test('the removed Accord is 6 days (March 10 to 16) and stays 6 as time passes', () => {
      assert.deepEqual(queries.findVehicle(DEALERSHIP, accord.vin), { ...asRemoved(accord, '2026-03-16'), daysInInventory: 6 });

      clock.setToday('2026-04-15');

      assert.equal(queries.findVehicle(DEALERSHIP, accord.vin).daysInInventory, 6);
      assert.equal(queries.findVehicle(DEALERSHIP, civicMarch16.vin).daysInInventory, 71);
    });

    test('list results carry daysInInventory too', () => {
      const listed = queries.listVehicles(DEALERSHIP, { status: 'active' });
      assert.deepEqual(
        listed.map((vehicle) => [vehicle.vin, vehicle.daysInInventory]),
        [
          [civicMarch16.vin, 41],
          [pilot.vin, 0],
          [crv.vin, 11],
        ],
      );
      assert.deepEqual(
        queries.listVehicles(DEALERSHIP, { status: 'removed' }).map((vehicle) => vehicle.daysInInventory),
        [6],
      );
    });
  });

  describe('listVehicles', () => {
    test('passes the filter through', () => {
      assert.deepEqual(
        queries.listVehicles(DEALERSHIP, { status: 'active', condition: 'new' }).map((vehicle) => vehicle.vin),
        [crv.vin],
      );
    });

    test('A-9: an unknown dealership is NotFound, not an empty list', () => {
      assert.throws(
        () => queries.listVehicles('NEVER-SEEN', { status: 'active' }),
        (error) => error instanceof NotFoundError && error.resource === 'dealership' && error.identifier === 'NEVER-SEEN',
      );
    });
  });

  describe('findVehicle', () => {
    test('FR-16: finds a vehicle by a lower-case, padded VIN', () => {
      assert.equal(queries.findVehicle(DEALERSHIP, `  ${crv.vin.toLowerCase()} `).vin, crv.vin);
    });

    test('an unknown VIN in a known dealership is a vehicle NotFound', () => {
      assert.throws(
        () => queries.findVehicle(DEALERSHIP, '00000000000000000'),
        (error) => error instanceof NotFoundError && error.resource === 'vehicle',
      );
    });

    test('an unknown dealership is a dealership NotFound', () => {
      assert.throws(
        () => queries.findVehicle('NEVER-SEEN', crv.vin),
        (error) => error instanceof NotFoundError && error.resource === 'dealership',
      );
    });
  });

  test('listDealerships returns the repository summary', () => {
    assert.deepEqual(queries.listDealerships(), [
      { dealershipId: DEALERSHIP, latestFeedDate: '2026-03-16', activeVehicleCount: 3 },
    ]);
  });
});
