import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, summarize } from '../../src/domain/reconcile.js';
import { accord, asActive, asRemoved, civicMarch15, civicMarch16, crv, pilot } from '../fixtures/brief-example.js';

describe('reconcile', () => {
  test('first feed: every vehicle is added', () => {
    const result = reconcile([], [civicMarch15, crv, accord], '2026-03-15');

    assert.deepEqual(result.added, [civicMarch15, crv, accord]);
    assert.deepEqual(result.updated, []);
    assert.deepEqual(result.reactivated, []);
    assert.deepEqual(result.unchangedVins, []);
    assert.deepEqual(result.removedVins, []);
  });

  test('brief March 16 example: Civic updated, CR-V unchanged, Pilot added, Accord removed', () => {
    const existing = [asActive(civicMarch15), asActive(crv), asActive(accord)];
    const civicLowerCaseVin = { ...civicMarch16, vin: '2hgfe1f71nh304352' };

    const result = reconcile(existing, [civicLowerCaseVin, crv, pilot], '2026-03-16');

    assert.deepEqual(result.updated, [civicLowerCaseVin]);
    assert.deepEqual(result.unchangedVins, [crv.vin]);
    assert.deepEqual(result.added, [pilot]);
    assert.deepEqual(result.removedVins, [accord.vin]);
    assert.deepEqual(result.reactivated, []);
    assert.equal(result.feedDate, '2026-03-16');
    assert.deepEqual(summarize(result), { added: 1, updated: 1, unchanged: 1, removed: 1, reactivated: 0, active: 3 });
  });

  test('a change to stockedOn alone on an active vehicle counts as updated', () => {
    const restocked = { ...crv, stockedOn: '2026-03-12' };
    const result = reconcile([asActive(crv)], [restocked], '2026-03-16');

    assert.deepEqual(result.updated, [restocked]);
    assert.deepEqual(result.unchangedVins, []);
  });

  test('a change to trim from a value to null counts as updated', () => {
    const noTrim = { ...crv, trim: null };
    const result = reconcile([asActive(crv)], [noTrim], '2026-03-16');

    assert.deepEqual(result.updated, [noTrim]);
  });

  test('a removed VIN present again is reactivated with the feed data, not added', () => {
    const relisted = { ...accord, price: 29990, stockedOn: '2026-03-20' };
    const result = reconcile([asRemoved(accord, '2026-03-16')], [relisted], '2026-03-20');

    assert.deepEqual(result.reactivated, [relisted]);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.updated, []);
  });

  test('a removed VIN with identical data is still reactivated, not unchanged', () => {
    const result = reconcile([asRemoved(accord, '2026-03-16')], [accord], '2026-03-17');

    assert.deepEqual(result.reactivated, [accord]);
    assert.deepEqual(result.unchangedVins, []);
  });

  test('an already-removed VIN still absent is untouched (keeps its original removedOn)', () => {
    const existing = [asActive(crv), asRemoved(accord, '2026-03-16')];
    const result = reconcile(existing, [crv], '2026-03-17');

    assert.deepEqual(result.removedVins, []);
    assert.deepEqual(result.unchangedVins, [crv.vin]);
  });

  test('absent across several feeds: only the first absence removes it', () => {
    const afterFirstAbsence = reconcile([asActive(accord), asActive(crv)], [crv], '2026-03-16');
    assert.deepEqual(afterFirstAbsence.removedVins, [accord.vin]);

    const stored = [asRemoved(accord, '2026-03-16'), asActive(crv)];
    for (const laterFeedDate of ['2026-03-17', '2026-03-18']) {
      assert.deepEqual(reconcile(stored, [crv], laterFeedDate).removedVins, []);
    }
  });

  test('removed, reactivated, then absent again is removed again', () => {
    const result = reconcile([asActive(accord), asActive(crv)], [crv], '2026-03-25');

    assert.deepEqual(result.removedVins, [accord.vin]);
    assert.equal(result.feedDate, '2026-03-25');
  });

  test('an empty feed removes every active vehicle (D-4)', () => {
    const existing = [asActive(civicMarch15), asActive(crv), asRemoved(accord, '2026-03-16')];
    const result = reconcile(existing, [], '2026-03-17');

    assert.deepEqual(result.removedVins, [civicMarch15.vin, crv.vin]);
    assert.deepEqual(summarize(result), { added: 0, updated: 0, unchanged: 0, removed: 2, reactivated: 0, active: 0 });
  });

  test('matches stored VINs regardless of case', () => {
    const storedLowerCase = asActive({ ...crv, vin: crv.vin.toLowerCase() });
    const result = reconcile([storedLowerCase], [crv], '2026-03-16');

    assert.deepEqual(result.unchangedVins, [crv.vin]);
    assert.deepEqual(result.added, []);
    assert.deepEqual(result.removedVins, []);
  });

  test('throws on duplicate normalized VINs instead of silently picking one', () => {
    const duplicateCivic = { ...civicMarch15, vin: ' 2hgfe1f71nh304352 ' };
    assert.throws(() => reconcile([], [civicMarch15, duplicateCivic], '2026-03-15'), /duplicate VIN 2HGFE1F71NH304352/);
  });

  test('does not mutate its inputs', () => {
    const existing = [asActive(civicMarch15), asActive(accord)];
    const incoming = [civicMarch16, pilot];
    const existingSnapshot = structuredClone(existing);
    const incomingSnapshot = structuredClone(incoming);

    reconcile(existing, incoming, '2026-03-16');

    assert.deepEqual(existing, existingSnapshot);
    assert.deepEqual(incoming, incomingSnapshot);
  });
});

describe('summarize', () => {
  test('active counts added, updated, unchanged and reactivated, not removed', () => {
    const existing = [asActive(civicMarch15), asActive(crv), asRemoved(accord, '2026-03-16'), asActive(pilot)];
    const result = reconcile(existing, [civicMarch16, crv, accord], '2026-03-17');

    assert.deepEqual(summarize(result), { added: 0, updated: 1, unchanged: 1, removed: 1, reactivated: 1, active: 3 });
  });
});
