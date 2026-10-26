import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeFeedHash } from '../../src/domain/feed-hash.js';
import type { VehicleData } from '../../src/domain/vehicle.js';
import { accord, civicMarch15, crv } from '../fixtures/brief-example.js';

describe('computeFeedHash (D-3)', () => {
  const baseHash = computeFeedHash([civicMarch15, crv, accord]);

  test('is a SHA-256 hex digest', () => {
    assert.match(baseHash, /^[0-9a-f]{64}$/);
  });

  test('is independent of vehicle order', () => {
    assert.equal(computeFeedHash([accord, civicMarch15, crv]), baseHash);
  });

  test('is independent of VIN case and surrounding whitespace', () => {
    const civicLowerPadded = { ...civicMarch15, vin: '  2hgfe1f71nh304352 ' };
    assert.equal(computeFeedHash([civicLowerPadded, crv, accord]), baseHash);
  });

  test('is independent of surrounding whitespace in text fields', () => {
    const civicPadded = { ...civicMarch15, make: ' Honda ', model: 'Civic ', trim: ' EX', stockNumber: 'H2401 ' };
    assert.equal(computeFeedHash([civicPadded, crv, accord]), baseHash);
  });

  test('differs when a vehicle is added or dropped', () => {
    assert.notEqual(computeFeedHash([civicMarch15, crv]), baseHash);
    assert.notEqual(computeFeedHash([]), baseHash);
  });

  const fieldChanges: ReadonlyArray<readonly [string, VehicleData]> = [
    ['vin', { ...civicMarch15, vin: '2HGFE1F71NH304353' }],
    ['stockNumber', { ...civicMarch15, stockNumber: 'H2402' }],
    ['condition', { ...civicMarch15, condition: 'certified' }],
    ['lotStatus', { ...civicMarch15, lotStatus: 'in_transit' }],
    ['year', { ...civicMarch15, year: 2023 }],
    ['make', { ...civicMarch15, make: 'Acura' }],
    ['model', { ...civicMarch15, model: 'Integra' }],
    ['trim', { ...civicMarch15, trim: 'LX' }],
    ['trim (to null)', { ...civicMarch15, trim: null }],
    ['make (case only)', { ...civicMarch15, make: 'HONDA' }],
    ['price', { ...civicMarch15, price: 18494 }],
    ['mileage', { ...civicMarch15, mileage: 41851 }],
    ['stockedOn', { ...civicMarch15, stockedOn: '2026-02-04' }],
  ];

  for (const [fieldName, changedCivic] of fieldChanges) {
    test(`differs when ${fieldName} changes`, () => {
      assert.notEqual(computeFeedHash([changedCivic, crv, accord]), baseHash);
    });
  }
});
