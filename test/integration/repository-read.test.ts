import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { VehicleFilter } from '../../src/app/ports.js';
import { reconcile } from '../../src/domain/reconcile.js';
import type { VehicleData } from '../../src/domain/vehicle.js';
import type { SqlDatabase } from '../../src/infra/sqlite/driver.js';
import { RowMappingError, toStoredVehicle, type SqliteInventoryRepository } from '../../src/infra/sqlite/repository.js';
import { accord, asActive, asRemoved, civicMarch15, crv, pilot } from '../fixtures/brief-example.js';
import { openRepository } from '../helpers/sqlite-repository.js';

const DEALERSHIP = 'LHS-1042';
const OTHER_DEALERSHIP = 'OTHER-1';

// Extra stock so every filter has something to exclude.
const certifiedTacoma: VehicleData = {
  vin: '3TMCZ5AN1PM555555',
  stockNumber: 'T100',
  condition: 'certified',
  lotStatus: 'in_transit',
  year: 2023,
  make: 'toyota',
  model: 'Tacoma',
  trim: null,
  price: 34250,
  mileage: 12000,
  stockedOn: '2026-03-01',
};

describe('SqliteInventoryRepository read side', () => {
  let db: SqlDatabase;
  let repository: SqliteInventoryRepository;

  function applySnapshot(dealershipId: string, feedDate: string, vehicles: readonly VehicleData[]): void {
    repository.inTransaction((transaction) => {
      transaction.applyChanges(dealershipId, reconcile(transaction.loadVehicles(dealershipId), vehicles, feedDate));
      transaction.recordFeed(dealershipId, feedDate, `hash-${feedDate}`);
    });
  }

  function listVins(filter: VehicleFilter, dealershipId = DEALERSHIP): string[] {
    return repository.listVehicles(dealershipId, filter).map((vehicle) => vehicle.vin);
  }

  before(() => {
    ({ db, repository } = openRepository());
    // LHS-1042 ends with: active Civic, CR-V, Pilot, Tacoma; removed Accord (2026-03-16).
    applySnapshot(DEALERSHIP, '2026-03-15', [civicMarch15, crv, accord]);
    applySnapshot(DEALERSHIP, '2026-03-16', [civicMarch15, crv, pilot, certifiedTacoma]);
    // OTHER-1 has the same Accord VIN, still active, and an earlier feed.
    applySnapshot(OTHER_DEALERSHIP, '2026-03-10', [accord]);
  });

  after(() => {
    db.close();
  });

  describe('listDealerships (FR-15)', () => {
    test('lists each known dealership with its latest feed date and active count, ordered by id', () => {
      assert.deepEqual(repository.listDealerships(), [
        { dealershipId: DEALERSHIP, latestFeedDate: '2026-03-16', activeVehicleCount: 4 },
        { dealershipId: OTHER_DEALERSHIP, latestFeedDate: '2026-03-10', activeVehicleCount: 1 },
      ]);
    });

    test('a dealership whose last feed was empty is still listed with 0 active', () => {
      const { db: emptyDb, repository: emptyRepository } = openRepository();
      try {
        emptyRepository.inTransaction((transaction) => {
          transaction.applyChanges('EMPTY-1', reconcile([], [crv], '2026-03-15'));
          transaction.recordFeed('EMPTY-1', '2026-03-15', 'a');
        });
        emptyRepository.inTransaction((transaction) => {
          transaction.applyChanges('EMPTY-1', reconcile(transaction.loadVehicles('EMPTY-1'), [], '2026-03-16'));
          transaction.recordFeed('EMPTY-1', '2026-03-16', 'b');
        });
        assert.deepEqual(emptyRepository.listDealerships(), [
          { dealershipId: 'EMPTY-1', latestFeedDate: '2026-03-16', activeVehicleCount: 0 },
        ]);
      } finally {
        emptyDb.close();
      }
    });
  });

  describe('dealershipExists (FR-2)', () => {
    test('is true only for dealerships with an accepted feed', () => {
      assert.equal(repository.dealershipExists(DEALERSHIP), true);
      assert.equal(repository.dealershipExists('NEVER-SEEN'), false);
    });

    test('dealership ids are case-sensitive (A-1)', () => {
      assert.equal(repository.dealershipExists(DEALERSHIP.toLowerCase()), false);
    });
  });

  describe('listVehicles (FR-11, FR-14, A-12)', () => {
    test('active vehicles, ordered by VIN ascending', () => {
      assert.deepEqual(listVins({ status: 'active' }), [civicMarch15.vin, certifiedTacoma.vin, pilot.vin, crv.vin]);
    });

    test('returns full vehicles with status and removedOn', () => {
      assert.deepEqual(repository.listVehicles(DEALERSHIP, { status: 'removed' }), [asRemoved(accord, '2026-03-16')]);
      assert.deepEqual(repository.listVehicles(DEALERSHIP, { status: 'active', lotStatus: 'in_transit' }), [
        asActive(certifiedTacoma),
      ]);
    });

    test('filters by condition', () => {
      assert.deepEqual(listVins({ status: 'active', condition: 'new' }), [crv.vin]);
      assert.deepEqual(listVins({ status: 'active', condition: 'used' }), [civicMarch15.vin, pilot.vin]);
    });

    test('filters by lot status', () => {
      assert.deepEqual(listVins({ status: 'active', lotStatus: 'on_lot' }), [civicMarch15.vin, pilot.vin, crv.vin]);
    });

    test('filters by make, ignoring case', () => {
      assert.deepEqual(listVins({ status: 'active', make: 'TOYOTA' }), [certifiedTacoma.vin]);
      assert.deepEqual(listVins({ status: 'active', make: 'honda' }), [civicMarch15.vin, pilot.vin, crv.vin]);
      assert.deepEqual(listVins({ status: 'active', make: 'Hond' }), []);
    });

    test('filters by maximum price, inclusive', () => {
      assert.deepEqual(listVins({ status: 'active', maxPrice: 34250 }), [civicMarch15.vin, certifiedTacoma.vin, crv.vin]);
      assert.deepEqual(listVins({ status: 'active', maxPrice: 34249 }), [civicMarch15.vin]);
    });

    test('combines filters with AND', () => {
      assert.deepEqual(listVins({ status: 'active', make: 'honda', maxPrice: 35000, lotStatus: 'on_lot' }), [civicMarch15.vin, crv.vin]);
      assert.deepEqual(listVins({ status: 'active', condition: 'new', make: 'toyota' }), []);
    });

    test('status=removed accepts the same filters', () => {
      assert.deepEqual(listVins({ status: 'removed', condition: 'new' }), [accord.vin]);
      assert.deepEqual(listVins({ status: 'removed', condition: 'used' }), []);
    });

    test('only returns the requested dealership', () => {
      assert.deepEqual(listVins({ status: 'active' }, OTHER_DEALERSHIP), [accord.vin]);
      assert.deepEqual(listVins({ status: 'removed' }, OTHER_DEALERSHIP), []);
      assert.deepEqual(listVins({ status: 'active' }, 'NEVER-SEEN'), []);
    });
  });

  describe('findVehicle (FR-6, FR-12, FR-16)', () => {
    test('finds an active vehicle by a lower-case, padded VIN', () => {
      assert.deepEqual(repository.findVehicle(DEALERSHIP, ` ${civicMarch15.vin.toLowerCase()} `), asActive(civicMarch15));
    });

    test('finds a removed vehicle', () => {
      assert.deepEqual(repository.findVehicle(DEALERSHIP, accord.vin), asRemoved(accord, '2026-03-16'));
    });

    test('scopes the lookup to the dealership', () => {
      assert.deepEqual(repository.findVehicle(OTHER_DEALERSHIP, accord.vin), asActive(accord));
      assert.equal(repository.findVehicle(OTHER_DEALERSHIP, crv.vin), undefined);
      assert.equal(repository.findVehicle('NEVER-SEEN', crv.vin), undefined);
    });
  });
});

describe('toStoredVehicle row mapper', () => {
  const validRow = {
    vin: '2HGFE1F71NH304352',
    stock_number: 'H2401',
    condition: 'used',
    lot_status: 'on_lot',
    year: 2022,
    make: 'Honda',
    model: 'Civic',
    trim: null,
    price: 18495,
    mileage: 41850,
    stocked_on: '2026-02-03',
    status: 'removed',
    removed_on: '2026-03-16',
  };

  test('maps a valid row', () => {
    assert.deepEqual(toStoredVehicle(validRow), asRemoved({ ...civicMarch15, trim: null }, '2026-03-16'));
  });

  const malformedRows: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['missing column', { ...validRow, vin: undefined }],
    ['text column holding a number', { ...validRow, make: 7 }],
    ['unknown condition', { ...validRow, condition: 'cpo' }],
    ['unknown status', { ...validRow, status: 'sold' }],
    ['non-integer price', { ...validRow, price: 18495.5 }],
    ['bigint year', { ...validRow, year: 2022n }],
    ['invalid stocked_on date', { ...validRow, stocked_on: '2026-02-30' }],
    ['removed without removed_on', { ...validRow, removed_on: null }],
    ['active with removed_on', { ...validRow, status: 'active' }],
  ];

  for (const [description, row] of malformedRows) {
    test(`throws RowMappingError for ${description}`, () => {
      assert.throws(() => toStoredVehicle(row), RowMappingError);
    });
  }
});
