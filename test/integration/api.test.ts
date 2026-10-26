import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { VehicleData } from '../../src/domain/vehicle.js';
import { MAX_BODY_SIZE_BYTES, MAX_BODY_SIZE_MEGABYTES } from '../../src/http/limits.js';
import { accord, civicMarch15, civicMarch16, crv, pilot } from '../fixtures/brief-example.js';
import { startTestServer, type TestServer } from '../helpers/api-server.js';

const DEALERSHIP = 'LHS-1042';
const OTHER_DEALERSHIP = 'OTHER-1';

const march15Feed = { dealershipId: DEALERSHIP, feedDate: '2026-03-15', vehicles: [civicMarch15, crv, accord] };
const march16Feed = {
  dealershipId: DEALERSHIP,
  feedDate: '2026-03-16',
  vehicles: [{ ...civicMarch16, vin: '2hgfe1f71nh304352' }, crv, pilot],
};

function feed(feedDate: string, vehicles: readonly unknown[], dealershipId = DEALERSHIP) {
  return { dealershipId, feedDate, vehicles };
}

/** The documented vehicle representation, in field order. */
function vehicleResponse(vehicle: VehicleData, status: 'active' | 'removed', removedOn: string | null, daysInInventory: number) {
  return {
    vin: vehicle.vin,
    stockNumber: vehicle.stockNumber,
    condition: vehicle.condition,
    lotStatus: vehicle.lotStatus,
    year: vehicle.year,
    make: vehicle.make,
    model: vehicle.model,
    trim: vehicle.trim,
    price: vehicle.price,
    mileage: vehicle.mileage,
    stockedOn: vehicle.stockedOn,
    status,
    removedOn,
    daysInInventory,
  };
}

describe('Inventory API', () => {
  let api: TestServer;

  beforeEach(async () => {
    api = await startTestServer('2026-03-16');
  });

  afterEach(async () => {
    await api.close();
  });

  async function vehiclesPath(path = '', dealershipId = DEALERSHIP) {
    return api.get(`/v1/dealerships/${encodeURIComponent(dealershipId)}/vehicles${path}`);
  }

  async function postFeed(body: unknown) {
    return api.post('/v1/feeds', body);
  }

  /** Every observable piece of state for a dealership, for "nothing changed" assertions. */
  async function snapshot(dealershipId = DEALERSHIP) {
    const [active, removed, dealerships] = await Promise.all([
      vehiclesPath('', dealershipId),
      vehiclesPath('?status=removed', dealershipId),
      api.get('/v1/dealerships'),
    ]);
    return { active: active.body, removed: removed.body, dealerships: dealerships.body };
  }

  describe('brief example progression (§6.1)', () => {
    test('March 15 then March 16, VIN lookup, replays, stale, conflicts, and validation', async () => {
      const first = await postFeed(march15Feed);
      assert.equal(first.status, 201);
      assert.deepEqual(first.body, {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-15',
        status: 'applied',
        summary: { added: 3, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active: 3 },
      });

      const second = await postFeed(march16Feed);
      assert.equal(second.status, 201);
      assert.deepEqual(second.body, {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-16',
        status: 'applied',
        summary: { added: 1, updated: 1, unchanged: 1, removed: 1, reactivated: 0, active: 3 },
      });

      // Civic updated, lowercase VIN did not create a second vehicle, CR-V unchanged, Pilot added.
      assert.deepEqual((await vehiclesPath()).body, {
        vehicles: [
          vehicleResponse(civicMarch16, 'active', null, 41),
          vehicleResponse(pilot, 'active', null, 0),
          vehicleResponse(crv, 'active', null, 11),
        ],
        count: 3,
      });

      // Accord removed, still retrievable, 6 days.
      const accordLookup = await vehiclesPath(`/${accord.vin}`);
      assert.equal(accordLookup.status, 200);
      assert.deepEqual(accordLookup.body, vehicleResponse(accord, 'removed', '2026-03-16', 6));

      const afterMarch16 = await snapshot();

      const replayLatest = await postFeed(march16Feed);
      assert.equal(replayLatest.status, 200);
      assert.deepEqual(replayLatest.body, {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-16',
        status: 'replayed',
        summary: { added: 0, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active: 3 },
      });

      const replayOlder = await postFeed(march15Feed);
      assert.equal(replayOlder.status, 200);
      assert.deepEqual(replayOlder.body, {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-15',
        status: 'replayed',
        summary: { added: 0, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active: 3 },
      });

      const stale = await postFeed(feed('2026-03-14', [pilot]));
      assert.equal(stale.status, 409);
      assert.deepEqual(stale.body, {
        error: {
          code: 'STALE_FEED',
          message: 'Feed 2026-03-14 for LHS-1042 is older than the latest accepted feed 2026-03-16',
          latestFeedDate: '2026-03-16',
        },
      });

      const olderConflict = await postFeed(feed('2026-03-15', [crv]));
      assert.equal(olderConflict.status, 409);
      assert.deepEqual(olderConflict.body, {
        error: {
          code: 'FEED_CONFLICT',
          message: 'A different feed for LHS-1042 on 2026-03-15 was already accepted',
          feedDate: '2026-03-15',
        },
      });

      const latestConflict = await postFeed({ ...march16Feed, vehicles: [{ ...civicMarch16, price: 16995 }, crv, pilot] });
      assert.equal(latestConflict.status, 409);

      const future = await postFeed(feed('2099-01-01', [crv]));
      assert.equal(future.status, 422);

      const cpo = await postFeed(feed('2026-03-17', [{ ...crv, condition: 'cpo' }]));
      assert.equal(cpo.status, 422);

      assert.deepEqual(await snapshot(), afterMarch16);
    });
  });

  describe('idempotency (FR-8, D-3)', () => {
    test('a feed with reordered vehicles and re-cased VINs replays', async () => {
      await postFeed(march15Feed);
      const reordered = feed('2026-03-15', [accord, { ...crv, vin: crv.vin.toLowerCase() }, civicMarch15]);

      const response = await postFeed(reordered);

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-15',
        status: 'replayed',
        summary: { added: 0, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active: 3 },
      });
    });
  });

  describe('reactivation (FR-7)', () => {
    test('a removed vehicle that reappears is active with the new stockedOn and data', async () => {
      await postFeed(march15Feed);
      await postFeed(march16Feed);
      const relisted = { ...accord, price: 29990, stockedOn: '2026-03-18' };
      api.clock.setToday('2026-03-20'); // D-10: feedDate may be at most today + 1

      const response = await postFeed(feed('2026-03-18', [relisted]));

      assert.equal(response.status, 201);
      assert.deepEqual(response.body, {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-18',
        status: 'applied',
        summary: { added: 0, updated: 0, unchanged: 0, removed: 3, reactivated: 1, active: 1 },
      });
      assert.deepEqual((await vehiclesPath(`/${accord.vin}`)).body, vehicleResponse(relisted, 'active', null, 2));
    });
  });

  describe('lifecycle (FR-5, FR-7)', () => {
    test('remove, reactivate, remove again: removedOn is the second absence', async () => {
      await postFeed(feed('2026-03-10', [accord, crv]));
      await postFeed(feed('2026-03-11', [crv]));
      await postFeed(feed('2026-03-12', [accord, crv]));
      await postFeed(feed('2026-03-13', [crv]));

      assert.deepEqual((await vehiclesPath(`/${accord.vin}`)).body, vehicleResponse(accord, 'removed', '2026-03-13', 3));
    });

    test('absent across three feeds keeps the first removedOn', async () => {
      await postFeed(feed('2026-03-10', [accord, crv]));
      await postFeed(feed('2026-03-11', [crv]));
      await postFeed(feed('2026-03-12', [crv]));
      await postFeed(feed('2026-03-13', [crv]));

      assert.deepEqual((await vehiclesPath(`/${accord.vin}`)).body, vehicleResponse(accord, 'removed', '2026-03-11', 1));
    });

    test('a gap between feed dates removes by feed, not by elapsed days', async () => {
      await postFeed(march15Feed);
      api.clock.setToday('2026-03-20'); // D-10: feedDate may be at most today + 1
      await postFeed(feed('2026-03-20', [crv]));

      const removed = await vehiclesPath('?status=removed');
      assert.deepEqual(removed.body, {
        vehicles: [vehicleResponse(accord, 'removed', '2026-03-20', 10), vehicleResponse(civicMarch15, 'removed', '2026-03-20', 45)],
        count: 2,
      });
    });
  });

  describe('days in inventory (FR-13)', () => {
    test('active days grow with the clock; removed days stay frozen', async () => {
      await postFeed(march15Feed);
      await postFeed(march16Feed);

      api.clock.setToday('2026-04-15');

      assert.equal(daysOf((await vehiclesPath(`/${crv.vin}`)).body), 41);
      assert.equal(daysOf((await vehiclesPath(`/${accord.vin}`)).body), 6);
    });
  });

  describe('empty feed (D-4)', () => {
    test('is accepted, removes everything, and the dealership stays listed with 0 active', async () => {
      await postFeed(march15Feed);

      const response = await postFeed(feed('2026-03-16', []));

      assert.equal(response.status, 201);
      assert.deepEqual((await vehiclesPath()).body, { vehicles: [], count: 0 });
      assert.deepEqual((await api.get('/v1/dealerships')).body, {
        dealerships: [{ dealershipId: DEALERSHIP, latestFeedDate: '2026-03-16', activeVehicleCount: 0 }],
      });
    });
  });

  describe('atomicity (FR-9)', () => {
    test('one invalid vehicle rejects the whole feed and leaves inventory identical', async () => {
      await postFeed(march15Feed);
      const before = await snapshot();

      const response = await postFeed(feed('2026-03-16', [civicMarch16, pilot, { ...crv, mileage: -1 }]));

      assert.equal(response.status, 422);
      assert.deepEqual(await snapshot(), before);
    });

    test('an invalid first feed does not create the dealership', async () => {
      const response = await postFeed(feed('2026-03-15', [civicMarch15, { ...crv, condition: 'cpo' }]));

      assert.equal(response.status, 422);
      assert.equal((await vehiclesPath()).status, 404);
      assert.deepEqual((await api.get('/v1/dealerships')).body, { dealerships: [] });
    });
  });

  describe('validation errors (FR-10)', () => {
    test('a bad condition returns the documented error envelope', async () => {
      const response = await postFeed(feed('2026-03-15', [civicMarch15, { ...crv, condition: 'cpo' }]));

      assert.equal(response.status, 422);
      assert.deepEqual(response.body, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Feed rejected: 1 problem found. No inventory was changed.',
          details: [
            { path: 'vehicles[1].condition', code: 'invalid_value', message: 'Expected one of: new, used, certified (received "cpo")' },
          ],
          truncated: false,
        },
      });
    });

    test('several problems are reported together, with paths', async () => {
      const response = await postFeed({
        dealershipId: DEALERSHIP,
        feedDate: '2026-02-30',
        vehicles: [civicMarch15, { ...crv, vin: crv.vin.slice(1), price: 1.5 }, { ...civicMarch15, vin: civicMarch15.vin.toLowerCase() }],
      });

      assert.equal(response.status, 422);
      assert.deepEqual(detailPaths(response.body).sort(), ['feedDate', 'vehicles[1].price', 'vehicles[1].vin', 'vehicles[2].vin']);
    });

    test('a future feedDate is rejected at path feedDate (D-10)', async () => {
      const response = await postFeed(feed('2026-03-18', [crv]));

      assert.equal(response.status, 422);
      assert.deepEqual(detailPaths(response.body), ['feedDate']);
    });

    for (const [description, body] of [
      ['array', '[]'],
      ['null', 'null'],
      ['string', '"feed"'],
    ] as const) {
      test(`a top-level ${description} body is 422 at path ""`, async () => {
        const response = await api.postRaw('/v1/feeds', body, { 'content-type': 'application/json' });
        assert.equal(response.status, 422);
        assert.deepEqual(detailPaths(response.body), ['']);
      });
    }

    test('an unknown key is ignored and the feed accepted (A-2)', async () => {
      const response = await postFeed({ ...feed('2026-03-15', [{ ...crv, color: 'blue' }]), source: 'dms' });
      assert.equal(response.status, 201);
      assert.equal(Object.hasOwn(objectAt((await vehiclesPath(`/${crv.vin}`)).body), 'color'), false);
    });

    test('omitted trim is stored and returned as null', async () => {
      const { trim: _omitted, ...crvWithoutTrim } = crv;
      await postFeed(feed('2026-03-15', [crvWithoutTrim]));
      assert.equal(objectAt((await vehiclesPath(`/${crv.vin}`)).body)['trim'], null);
    });
  });

  describe('request format errors', () => {
    test('malformed JSON is 400 INVALID_JSON', async () => {
      const response = await api.postRaw('/v1/feeds', '{"dealershipId": ', { 'content-type': 'application/json' });
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), 'INVALID_JSON');
    });

    test('a non-JSON content type is 415 UNSUPPORTED_MEDIA_TYPE', async () => {
      const response = await api.postRaw('/v1/feeds', JSON.stringify(march15Feed), { 'content-type': 'text/plain' });
      assert.equal(response.status, 415);
      assert.equal(errorCode(response.body), 'UNSUPPORTED_MEDIA_TYPE');
    });

    test('a missing content type is 415', async () => {
      const response = await api.postRaw('/v1/feeds', JSON.stringify(march15Feed), {});
      assert.equal(response.status, 415);
    });

    test('application/json with a charset is accepted', async () => {
      const response = await api.postRaw('/v1/feeds', JSON.stringify(march15Feed), { 'content-type': 'application/json; charset=utf-8' });
      assert.equal(response.status, 201);
    });

    test('a body over the limit is 413 PAYLOAD_TOO_LARGE and names the limit', async () => {
      const oversized = JSON.stringify({ ...march15Feed, padding: 'x'.repeat(MAX_BODY_SIZE_BYTES) });
      const response = await api.postRaw('/v1/feeds', oversized, { 'content-type': 'application/json' });
      assert.equal(response.status, 413);
      assert.equal(errorCode(response.body), 'PAYLOAD_TOO_LARGE');
      assert.equal(errorMessage(response.body), `Request body exceeds the ${MAX_BODY_SIZE_MEGABYTES} MB limit.`);
    });

    test('the body limit is 10 MB (A-10)', () => {
      assert.equal(MAX_BODY_SIZE_MEGABYTES, 10);
      assert.equal(MAX_BODY_SIZE_BYTES, 10 * 1024 * 1024);
    });

    test('an unknown route is 404 NOT_FOUND as JSON', async () => {
      const response = await api.get('/v1/nope');
      assert.equal(response.status, 404);
      assert.equal(errorCode(response.body), 'NOT_FOUND');
    });
  });

  describe('multi-tenancy (FR-2)', () => {
    test('a feed for one dealership leaves another untouched; the same VIN coexists', async () => {
      await postFeed(feed('2026-03-01', [crv, accord], OTHER_DEALERSHIP));
      const otherBefore = await vehiclesPath('', OTHER_DEALERSHIP);

      await postFeed(march15Feed);
      await postFeed(feed('2026-03-16', []));

      assert.deepEqual((await vehiclesPath('', OTHER_DEALERSHIP)).body, otherBefore.body);
      assert.equal(objectAt((await vehiclesPath(`/${crv.vin}`)).body)['status'], 'removed');
      assert.equal(objectAt((await vehiclesPath(`/${crv.vin}`, OTHER_DEALERSHIP)).body)['status'], 'active');
    });

    test('dealership ids needing URL encoding work in paths', async () => {
      await postFeed(feed('2026-03-15', [crv], 'North Lot/7'));
      const response = await vehiclesPath('', 'North Lot/7');
      assert.equal(response.status, 200);
      assert.equal(objectAt(response.body)['count'], 1);
    });
  });

  describe('filters (FR-11, FR-14, A-12)', () => {
    beforeEach(async () => {
      await postFeed(march15Feed);
      await postFeed(march16Feed);
    });

    async function listedVins(query: string): Promise<unknown[]> {
      const response = await vehiclesPath(query);
      assert.equal(response.status, 200);
      return arrayAt(objectAt(response.body)['vehicles']).map((vehicle) => objectAt(vehicle)['vin']);
    }

    test('each filter alone and combined, ordered by VIN', async () => {
      assert.deepEqual(await listedVins('?condition=used'), [civicMarch16.vin, pilot.vin]);
      assert.deepEqual(await listedVins('?lotStatus=on_lot'), [civicMarch16.vin, pilot.vin, crv.vin]);
      assert.deepEqual(await listedVins('?make=HONDA'), [civicMarch16.vin, pilot.vin, crv.vin]);
      assert.deepEqual(await listedVins('?maxPrice=34250'), [civicMarch16.vin, crv.vin]);
      assert.deepEqual(await listedVins('?maxPrice=34249'), [civicMarch16.vin]);
      assert.deepEqual(await listedVins('?condition=used&maxPrice=20000&make=honda'), [civicMarch16.vin]);
    });

    test('status=removed lists removed vehicles and accepts filters', async () => {
      assert.deepEqual(await listedVins('?status=removed'), [accord.vin]);
      assert.deepEqual(await listedVins('?status=removed&condition=used'), []);
    });

    for (const query of ['?condition=cpo', '?maxPrice=abc', '?maxPrice=0', '?status=sold', '?color=red', '?condition=new&condition=used']) {
      test(`invalid query ${query} is 400 INVALID_REQUEST`, async () => {
        const response = await vehiclesPath(query);
        assert.equal(response.status, 400);
        assert.equal(errorCode(response.body), 'INVALID_REQUEST');
      });
    }
  });

  describe('VIN lookup (FR-6, FR-12, FR-16)', () => {
    beforeEach(async () => {
      await postFeed(march15Feed);
    });

    test('a lower-case, padded VIN finds the vehicle', async () => {
      const response = await vehiclesPath(`/${encodeURIComponent(` ${crv.vin.toLowerCase()} `)}`);
      assert.equal(response.status, 200);
      assert.equal(objectAt(response.body)['vin'], crv.vin);
    });

    test('an unknown VIN is 404', async () => {
      const response = await vehiclesPath('/00000000000000000');
      assert.equal(response.status, 404);
      assert.equal(errorCode(response.body), 'NOT_FOUND');
    });

    test('an unknown dealership is 404 for lists and lookups (A-9)', async () => {
      assert.equal((await vehiclesPath('', 'NEVER-SEEN')).status, 404);
      assert.equal((await vehiclesPath(`/${crv.vin}`, 'NEVER-SEEN')).status, 404);
    });

    test('a VIN that is not 17 characters is 400 INVALID_REQUEST', async () => {
      const response = await vehiclesPath('/SHORTVIN');
      assert.equal(response.status, 400);
      assert.equal(errorCode(response.body), 'INVALID_REQUEST');
      assert.deepEqual(detailPaths(response.body), ['vin']);
    });
  });

  describe('dealership list (FR-15)', () => {
    test('lists latest feed date and active count, ordered by id', async () => {
      await postFeed(feed('2026-03-01', [crv], OTHER_DEALERSHIP));
      await postFeed(march15Feed);
      await postFeed(march16Feed);

      assert.deepEqual((await api.get('/v1/dealerships')).body, {
        dealerships: [
          { dealershipId: DEALERSHIP, latestFeedDate: '2026-03-16', activeVehicleCount: 3 },
          { dealershipId: OTHER_DEALERSHIP, latestFeedDate: '2026-03-01', activeVehicleCount: 1 },
        ],
      });
    });
  });

  describe('concurrency (D-5)', () => {
    test('two same-date feeds with different content: exactly one 201 and one 409', async () => {
      await postFeed(feed('2026-03-14', [crv]));

      const responses = await Promise.all([postFeed(feed('2026-03-15', [civicMarch15])), postFeed(feed('2026-03-15', [pilot]))]);

      assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    });

    test('two different-date feeds together: final state always equals the later feed', async () => {
      const responses = await Promise.all([postFeed(feed('2026-03-16', [pilot, crv])), postFeed(feed('2026-03-15', [civicMarch15, accord]))]);

      for (const response of responses) {
        assert.ok([201, 409].includes(response.status), `unexpected status ${response.status}`);
      }
      const activeVins = arrayAt(objectAt((await vehiclesPath()).body)['vehicles']).map((vehicle) => objectAt(vehicle)['vin']);
      assert.deepEqual(activeVins, [pilot.vin, crv.vin]);
    });
  });

  describe('operations (NFR-5)', () => {
    test('/healthz is 200 ok while the database is usable', async () => {
      const response = await api.get('/healthz');
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { status: 'ok' });
    });

    test('/healthz is 503 when the database is closed', async () => {
      api.closeDatabase();
      const response = await api.get('/healthz');
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, { status: 'unavailable' });
    });

    test('an unexpected failure is 500 INTERNAL without internals', async () => {
      api.closeDatabase();
      const response = await api.get('/v1/dealerships');
      assert.equal(response.status, 500);
      assert.deepEqual(response.body, { error: { code: 'INTERNAL', message: 'Internal server error' } });
    });

    test('responses carry a request id, echoing a valid incoming one', async () => {
      const generated = await api.get('/healthz');
      assert.match(generated.headers.get('x-request-id') ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      const echoed = await api.get('/healthz', { 'x-request-id': 'trace-123' });
      assert.equal(echoed.headers.get('x-request-id'), 'trace-123');
    });

    test('an unsafe incoming request id is replaced, not echoed', async () => {
      const response = await api.get('/healthz', { 'x-request-id': 'x'.repeat(200) });
      assert.notEqual(response.headers.get('x-request-id'), 'x'.repeat(200));
    });
  });
});

// Helpers that read unknown JSON without casts.

function objectAt(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), `expected an object, got ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}

function arrayAt(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), `expected an array, got ${JSON.stringify(value)}`);
  return value;
}

function errorCode(body: unknown): unknown {
  return objectAt(objectAt(body)['error'])['code'];
}

function errorMessage(body: unknown): unknown {
  return objectAt(objectAt(body)['error'])['message'];
}

function detailPaths(body: unknown): unknown[] {
  return arrayAt(objectAt(objectAt(body)['error'])['details']).map((detail) => objectAt(detail)['path']);
}

function daysOf(body: unknown): unknown {
  return objectAt(body)['daysInInventory'];
}
