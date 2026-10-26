import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_REPORTED_PROBLEMS,
  parseDealershipId,
  parseFeedBody,
  parseVehicleListQuery,
  parseVin,
  type ParseResult,
  type Problem,
} from '../../src/http/schemas.js';
import { civicMarch15, crv } from '../fixtures/brief-example.js';

const TODAY = '2026-03-16';

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { dealershipId: 'LHS-1042', feedDate: '2026-03-15', vehicles: [{ ...civicMarch15 }, { ...crv }], ...overrides };
}

function bodyWithVehicle(vehicleOverrides: Record<string, unknown>): Record<string, unknown> {
  return validBody({ vehicles: [{ ...civicMarch15, ...vehicleOverrides }] });
}

function problemsOf<T>(result: ParseResult<T>): readonly Problem[] {
  assert.equal(result.success, false, 'expected parsing to fail');
  return result.success ? [] : result.problems;
}

function valueOf<T>(result: ParseResult<T>): T {
  if (!result.success) {
    assert.fail(`expected parsing to succeed, got ${JSON.stringify(result.problems)}`);
  }
  return result.value;
}

function problemPaths<T>(result: ParseResult<T>): string[] {
  return problemsOf(result).map((problem) => problem.path);
}

describe('parseFeedBody', () => {
  test('accepts the brief March 15 feed unchanged', () => {
    assert.deepEqual(valueOf(parseFeedBody(validBody(), TODAY)), {
      dealershipId: 'LHS-1042',
      feedDate: '2026-03-15',
      vehicles: [civicMarch15, crv],
    });
  });

  test('normalizes: VIN trimmed and upper-cased, strings trimmed, dealershipId trimmed', () => {
    const feed = valueOf(
      parseFeedBody(
        { ...bodyWithVehicle({ vin: ' 2hgfe1f71nh304352 ', make: ' Honda ', stockNumber: 'H2401 ' }), dealershipId: ' LHS-1042 ' },
        TODAY,
      ),
    );
    assert.equal(feed.dealershipId, 'LHS-1042');
    assert.deepEqual(feed.vehicles, [civicMarch15]);
  });

  test('omitted and null trim both become null', () => {
    const { trim: _omitted, ...civicWithoutTrim } = civicMarch15;
    const withoutTrim = valueOf(parseFeedBody(validBody({ vehicles: [civicWithoutTrim] }), TODAY));
    const nullTrim = valueOf(parseFeedBody(bodyWithVehicle({ trim: null }), TODAY));

    assert.equal(withoutTrim.vehicles[0]?.trim, null);
    assert.deepEqual(withoutTrim, nullTrim);
  });

  test('A-2: unknown keys are ignored and stripped', () => {
    const feed = valueOf(parseFeedBody({ ...bodyWithVehicle({ color: 'blue' }), source: 'dms' }, TODAY));
    assert.deepEqual(feed, { dealershipId: 'LHS-1042', feedDate: '2026-03-15', vehicles: [civicMarch15] });
  });

  test('D-4: an empty vehicles array is valid', () => {
    assert.deepEqual(valueOf(parseFeedBody(validBody({ vehicles: [] }), TODAY)).vehicles, []);
  });

  test('accepts boundary values: year 1000 and 9999, mileage 0, price 1', () => {
    valueOf(parseFeedBody(bodyWithVehicle({ year: 1000, mileage: 0, price: 1 }), TODAY));
    valueOf(parseFeedBody(bodyWithVehicle({ year: 9999 }), TODAY));
  });

  describe('rejects with the path of the problem (FR-10)', () => {
    const invalidVehicles: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
      ['condition "cpo"', { condition: 'cpo' }, 'vehicles[0].condition'],
      ['unknown lotStatus', { lotStatus: 'sold' }, 'vehicles[0].lotStatus'],
      ['a 16-character VIN', { vin: '2HGFE1F71NH30435' }, 'vehicles[0].vin'],
      ['an 18-character VIN', { vin: '2HGFE1F71NH3043521' }, 'vehicles[0].vin'],
      ['an impossible stockedOn date', { stockedOn: '2026-02-30' }, 'vehicles[0].stockedOn'],
      ['a non-ISO stockedOn date', { stockedOn: '03/15/2026' }, 'vehicles[0].stockedOn'],
      ['negative mileage', { mileage: -1 }, 'vehicles[0].mileage'],
      ['a fractional price', { price: 18495.5 }, 'vehicles[0].price'],
      ['a zero price', { price: 0 }, 'vehicles[0].price'],
      ['a price given as a string', { price: '18495' }, 'vehicles[0].price'],
      ['a three-digit year', { year: 999 }, 'vehicles[0].year'],
      ['an empty trim', { trim: '' }, 'vehicles[0].trim'],
      ['a whitespace-only make', { make: '   ' }, 'vehicles[0].make'],
      ['a missing model', { model: undefined }, 'vehicles[0].model'],
      ['a stock number over 50 characters', { stockNumber: 'S'.repeat(51) }, 'vehicles[0].stockNumber'],
    ];

    for (const [description, vehicleOverrides, expectedPath] of invalidVehicles) {
      test(description, () => {
        assert.deepEqual(problemPaths(parseFeedBody(bodyWithVehicle(vehicleOverrides), TODAY)), [expectedPath]);
      });
    }

    test('condition "cpo" explains the allowed values and what was received', () => {
      const [problem] = problemsOf(parseFeedBody(bodyWithVehicle({ condition: 'cpo' }), TODAY));
      assert.equal(problem?.code, 'invalid_value');
      assert.equal(problem?.message, 'Expected one of: new, used, certified (received "cpo")');
    });

    test('an impossible feedDate', () => {
      assert.deepEqual(problemPaths(parseFeedBody(validBody({ feedDate: '2026-02-30' }), TODAY)), ['feedDate']);
    });

    test('a missing or empty dealershipId', () => {
      assert.deepEqual(problemPaths(parseFeedBody(validBody({ dealershipId: undefined }), TODAY)), ['dealershipId']);
      assert.deepEqual(problemPaths(parseFeedBody(validBody({ dealershipId: '  ' }), TODAY)), ['dealershipId']);
    });

    test('a dealershipId over 128 characters or with control characters', () => {
      assert.deepEqual(problemPaths(parseFeedBody(validBody({ dealershipId: 'D'.repeat(129) }), TODAY)), ['dealershipId']);
      assert.deepEqual(problemPaths(parseFeedBody(validBody({ dealershipId: 'LHS\n1042' }), TODAY)), ['dealershipId']);
    });

    test('vehicles that is not an array', () => {
      assert.deepEqual(problemPaths(parseFeedBody(validBody({ vehicles: {} }), TODAY)), ['vehicles']);
    });

    for (const [description, body] of [
      ['an array', []],
      ['null', null],
      ['a string', 'feed'],
      ['a number', 7],
    ] as const) {
      test(`a top-level ${description} body is reported at path ""`, () => {
        assert.deepEqual(problemPaths(parseFeedBody(body, TODAY)), ['']);
      });
    }
  });

  describe('D-10 future feedDate guard', () => {
    test('accepts today and today + 1', () => {
      valueOf(parseFeedBody(validBody({ feedDate: '2026-03-16' }), TODAY));
      valueOf(parseFeedBody(validBody({ feedDate: '2026-03-17' }), TODAY));
    });

    test('rejects today + 2 at path feedDate', () => {
      const [problem] = problemsOf(parseFeedBody(validBody({ feedDate: '2026-03-18' }), TODAY));
      assert.equal(problem?.path, 'feedDate');
      assert.equal(problem?.code, 'feed_date_in_future');
    });
  });

  describe('duplicate VINs', () => {
    test('a VIN repeated after case and whitespace normalization is rejected at the later index', () => {
      const body = validBody({ vehicles: [civicMarch15, crv, { ...civicMarch15, vin: ' 2hgfe1f71nh304352' }] });
      const problems = problemsOf(parseFeedBody(body, TODAY));

      assert.deepEqual(problems, [
        { path: 'vehicles[2].vin', code: 'duplicate_vin', message: 'Duplicates vehicles[0].vin (2HGFE1F71NH304352)' },
      ]);
    });

    test('are reported together with other problems in the same feed', () => {
      const body = validBody({ vehicles: [civicMarch15, { ...crv, condition: 'cpo' }, { ...civicMarch15 }] });
      assert.deepEqual(problemPaths(parseFeedBody(body, TODAY)).sort(), ['vehicles[1].condition', 'vehicles[2].vin']);
    });
  });

  test('reports every problem in one pass, each at its own path', () => {
    const body = {
      dealershipId: 'LHS-1042',
      feedDate: '2026-02-30',
      vehicles: [{ ...civicMarch15, condition: 'cpo', mileage: -5 }, { ...crv, vin: 'SHORT' }],
    };
    assert.deepEqual(problemPaths(parseFeedBody(body, TODAY)).sort(), [
      'feedDate',
      'vehicles[0].condition',
      'vehicles[0].mileage',
      'vehicles[1].vin',
    ]);
  });

  test(`caps the report at ${MAX_REPORTED_PROBLEMS} problems and flags truncation`, () => {
    const vehicles = Array.from({ length: 150 }, () => ({ ...civicMarch15, condition: 'cpo', vin: 'SHORT' }));
    const result = parseFeedBody(validBody({ vehicles }), TODAY);

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.problems.length, MAX_REPORTED_PROBLEMS);
      assert.equal(result.truncated, true);
    }
  });

  test('a small report is not flagged as truncated', () => {
    const result = parseFeedBody(bodyWithVehicle({ condition: 'cpo' }), TODAY);
    assert.equal(!result.success && result.truncated, false);
  });
});

describe('parseVehicleListQuery', () => {
  test('defaults to active with no other filters', () => {
    assert.deepEqual(valueOf(parseVehicleListQuery({})), { status: 'active' });
  });

  test('parses every filter', () => {
    assert.deepEqual(
      valueOf(parseVehicleListQuery({ status: 'removed', condition: 'used', lotStatus: 'on_lot', make: ' honda ', maxPrice: '20000' })),
      { status: 'removed', condition: 'used', lotStatus: 'on_lot', make: 'honda', maxPrice: 20000 },
    );
  });

  const invalidQueries: ReadonlyArray<readonly [string, Record<string, unknown>, string]> = [
    ['an unknown parameter', { color: 'red' }, ''],
    ['an unknown status', { status: 'sold' }, 'status'],
    ['an unknown condition', { condition: 'cpo' }, 'condition'],
    ['a non-numeric maxPrice', { maxPrice: 'cheap' }, 'maxPrice'],
    ['a zero maxPrice', { maxPrice: '0' }, 'maxPrice'],
    ['a fractional maxPrice', { maxPrice: '19999.99' }, 'maxPrice'],
    ['an empty make', { make: '' }, 'make'],
    ['a repeated parameter', { condition: ['new', 'used'] }, 'condition'],
  ];

  for (const [description, query, expectedPath] of invalidQueries) {
    test(`rejects ${description}`, () => {
      assert.deepEqual(problemPaths(parseVehicleListQuery(query)), [expectedPath]);
    });
  }
});

describe('parseVin / parseDealershipId (path parameters)', () => {
  test('a VIN is trimmed and upper-cased', () => {
    assert.equal(valueOf(parseVin(' 2hgfe1f71nh304352 ')), '2HGFE1F71NH304352');
  });

  test('a VIN that is not 17 characters after trimming is rejected', () => {
    assert.deepEqual(problemPaths(parseVin('2HGFE1F71NH30435')), ['vin']);
  });

  test('a dealership id is trimmed; ids are case-sensitive', () => {
    assert.equal(valueOf(parseDealershipId(' lhs-1042 ')), 'lhs-1042');
  });

  test('an empty dealership id is rejected', () => {
    assert.deepEqual(problemPaths(parseDealershipId(' ')), ['dealershipId']);
  });
});
