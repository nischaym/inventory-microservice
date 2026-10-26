import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { toUtcCalendarDate } from '../../src/domain/days.js';

describe('toUtcCalendarDate (A-7)', () => {
  test('formats the UTC date as YYYY-MM-DD', () => {
    assert.equal(toUtcCalendarDate(new Date('2026-03-16T12:00:00Z')), '2026-03-16');
  });

  test('uses the UTC day, not the local one, near midnight', () => {
    assert.equal(toUtcCalendarDate(new Date('2026-03-16T23:59:59Z')), '2026-03-16');
    assert.equal(toUtcCalendarDate(new Date('2026-03-16T23:30:00-05:00')), '2026-03-17');
    assert.equal(toUtcCalendarDate(new Date('2026-03-17T00:30:00+05:00')), '2026-03-16');
  });

  test('zero-pads month and day', () => {
    assert.equal(toUtcCalendarDate(new Date('2026-01-05T00:00:00Z')), '2026-01-05');
  });

  test('throws on an invalid Date instead of returning garbage', () => {
    assert.throws(() => toUtcCalendarDate(new Date('not a date')), RangeError);
  });
});
