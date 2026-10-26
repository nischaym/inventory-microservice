import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, daysInInventory, isCalendarDate, isFeedDateTooFarAhead } from '../../src/domain/days.js';

describe('isCalendarDate', () => {
  test('accepts real dates, including 29 Feb in a leap year', () => {
    assert.equal(isCalendarDate('2026-03-15'), true);
    assert.equal(isCalendarDate('2024-02-29'), true);
    assert.equal(isCalendarDate('2000-02-29'), true);
  });

  test('rejects impossible dates', () => {
    assert.equal(isCalendarDate('2026-02-30'), false);
    assert.equal(isCalendarDate('2026-02-29'), false);
    assert.equal(isCalendarDate('1900-02-29'), false);
    assert.equal(isCalendarDate('2026-13-01'), false);
    assert.equal(isCalendarDate('2026-00-10'), false);
    assert.equal(isCalendarDate('2026-04-31'), false);
  });

  test('rejects anything not shaped YYYY-MM-DD', () => {
    assert.equal(isCalendarDate('2026-3-15'), false);
    assert.equal(isCalendarDate(' 2026-03-15'), false);
    assert.equal(isCalendarDate('2026-03-15T00:00:00Z'), false);
    assert.equal(isCalendarDate('15/03/2026'), false);
    assert.equal(isCalendarDate(''), false);
  });

  test('keeps two-digit years literal instead of mapping them to the 1900s', () => {
    // Year 0 is a leap year; 1900 (what Date.UTC would map it to) is not.
    assert.equal(isCalendarDate('0000-02-29'), true);
  });
});

describe('daysInInventory (FR-13, A-5)', () => {
  test('brief example: Accord stocked 2026-03-10, removed 2026-03-16 is 6', () => {
    assert.equal(daysInInventory('2026-03-10', '2026-03-16'), 6);
  });

  test('same day is 0', () => {
    assert.equal(daysInInventory('2026-03-16', '2026-03-16'), 0);
  });

  test('crosses month and year boundaries', () => {
    assert.equal(daysInInventory('2026-01-31', '2026-02-01'), 1);
    assert.equal(daysInInventory('2025-12-31', '2026-01-01'), 1);
    assert.equal(daysInInventory('2025-03-16', '2026-03-16'), 365);
  });

  test('counts 29 February in leap years only', () => {
    assert.equal(daysInInventory('2024-02-28', '2024-03-01'), 2);
    assert.equal(daysInInventory('2026-02-28', '2026-03-01'), 1);
    assert.equal(daysInInventory('2024-03-16', '2025-03-16'), 365);
    assert.equal(daysInInventory('2023-03-16', '2024-03-16'), 366);
  });

  test('is clamped to 0 when stockedOn is after the reference date', () => {
    assert.equal(daysInInventory('2026-03-20', '2026-03-16'), 0);
  });

  test('throws on an invalid date instead of returning NaN', () => {
    assert.throws(() => daysInInventory('2026-02-30', '2026-03-16'), RangeError);
    assert.throws(() => daysInInventory('2026-03-10', 'not-a-date'), RangeError);
  });
});

describe('daysBetween', () => {
  test('is negative when the second date is earlier', () => {
    assert.equal(daysBetween('2026-03-16', '2026-03-10'), -6);
  });
});

describe('isFeedDateTooFarAhead (D-10)', () => {
  const today = '2026-03-31';

  test('accepts today and today + 1', () => {
    assert.equal(isFeedDateTooFarAhead('2026-03-31', today), false);
    assert.equal(isFeedDateTooFarAhead('2026-04-01', today), false);
  });

  test('rejects today + 2 and far-future dates', () => {
    assert.equal(isFeedDateTooFarAhead('2026-04-02', today), true);
    assert.equal(isFeedDateTooFarAhead('2099-01-01', today), true);
  });

  test('accepts past dates', () => {
    assert.equal(isFeedDateTooFarAhead('2020-01-01', today), false);
  });
});
