import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hasValidVinLength, normalizeVin } from '../../src/domain/vin.js';

describe('normalizeVin (FR-16)', () => {
  test('upper-cases a lower-case VIN', () => {
    assert.equal(normalizeVin('2hgfe1f71nh304352'), '2HGFE1F71NH304352');
  });

  test('trims surrounding whitespace, including tabs and newlines', () => {
    assert.equal(normalizeVin(' \t2HGFE1F71NH304352\n '), '2HGFE1F71NH304352');
  });

  test('handles mixed case and padding together', () => {
    assert.equal(normalizeVin('  2hGfE1f71Nh304352 '), '2HGFE1F71NH304352');
  });
});

describe('hasValidVinLength (D-9)', () => {
  test('accepts exactly 17 characters', () => {
    assert.equal(hasValidVinLength('2HGFE1F71NH304352'), true);
  });

  test('accepts 17 characters once surrounding whitespace is trimmed', () => {
    assert.equal(hasValidVinLength('   2HGFE1F71NH304352  '), true);
  });

  test('rejects 16 characters', () => {
    assert.equal(hasValidVinLength('2HGFE1F71NH30435'), false);
  });

  test('rejects 18 characters', () => {
    assert.equal(hasValidVinLength('2HGFE1F71NH3043521'), false);
  });

  test('rejects an empty or whitespace-only value', () => {
    assert.equal(hasValidVinLength(''), false);
    assert.equal(hasValidVinLength('                 '), false);
  });

  test('does not restrict inner characters (no check digit or charset rule)', () => {
    assert.equal(hasValidVinLength('IOQ-IOQ-IOQ-IOQ-!'), true);
  });
});
