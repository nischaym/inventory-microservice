// Keeps docs/openapi.json honest: its request examples are replayed against the real app
// and its response examples must equal what the app returns.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startTestServer, type TestServer } from '../helpers/api-server.js';

const openApi: unknown = JSON.parse(readFileSync(new URL('../../docs/openapi.json', import.meta.url), 'utf8'));

/** Navigates parsed JSON by keys, failing the test with the full path if anything is missing. */
function at(value: unknown, ...keys: string[]): unknown {
  let current = value;
  for (const [index, key] of keys.entries()) {
    assert.ok(
      typeof current === 'object' && current !== null && Object.hasOwn(current, key),
      `openapi.json has no ${keys.slice(0, index + 1).join(' > ')}`,
    );
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}

const feedsPost = ['paths', '/v1/feeds', 'post'];
const requestExample = (name: string) => at(openApi, ...feedsPost, 'requestBody', 'content', 'application/json', 'examples', name, 'value');
const feedResponseExample = (status: string) => at(openApi, ...feedsPost, 'responses', status, 'content', 'application/json', 'example');

describe('docs/openapi.json', () => {
  let api: TestServer;

  before(async () => {
    api = await startTestServer('2026-03-16');
  });

  after(async () => {
    await api.close();
  });

  test('every documented operation is routed by the app (no route-level 404)', async () => {
    const paths = at(openApi, 'paths');
    assert.ok(typeof paths === 'object' && paths !== null);
    const documented = Object.keys(paths).flatMap((path) => {
      const operations = at(paths, path);
      assert.ok(typeof operations === 'object' && operations !== null);
      return Object.keys(operations).map((method) => ({ method, path }));
    });
    assert.deepEqual(
      documented.map(({ method, path }) => `${method.toUpperCase()} ${path}`),
      [
        'POST /v1/feeds',
        'GET /v1/dealerships',
        'GET /v1/dealerships/{dealershipId}/vehicles',
        'GET /v1/dealerships/{dealershipId}/vehicles/{vin}',
        'GET /healthz',
      ],
    );

    for (const { method, path } of documented) {
      const concretePath = path.replace('{dealershipId}', 'UNKNOWN').replace('{vin}', '1HGCY1F39TA098765');
      const response = method === 'post' ? await api.post(concretePath, {}) : await api.get(concretePath);
      const message = JSON.stringify(response.body);
      assert.ok(!message.includes('No route for'), `${method.toUpperCase()} ${path} is documented but not routed`);
    }
  });

  test('request examples replay the brief scenario and response examples match real responses', async () => {
    assert.equal((await api.post('/v1/feeds', requestExample('march15'))).status, 201);

    const march16 = await api.post('/v1/feeds', requestExample('march16'));
    assert.equal(march16.status, 201);
    assert.deepEqual(march16.body, feedResponseExample('201'));

    const replay = await api.post('/v1/feeds', requestExample('march16'));
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, feedResponseExample('200'));

    const vehicleOperation = ['paths', '/v1/dealerships/{dealershipId}/vehicles/{vin}', 'get'];
    const accord = await api.get('/v1/dealerships/LHS-1042/vehicles/1HGCY1F39TA098765');
    assert.deepEqual(accord.body, at(openApi, ...vehicleOperation, 'responses', '200', 'content', 'application/json', 'example'));

    const dealerships = await api.get('/v1/dealerships');
    assert.deepEqual(dealerships.body, at(openApi, 'paths', '/v1/dealerships', 'get', 'responses', '200', 'content', 'application/json', 'example'));

    const conflictExamples = ['responses', '409', 'content', 'application/json', 'examples'];
    const stale = await api.post('/v1/feeds', { dealershipId: 'LHS-1042', feedDate: '2026-03-14', vehicles: [] });
    assert.deepEqual(stale.body, at(openApi, ...feedsPost, ...conflictExamples, 'stale', 'value'));
    const conflict = await api.post('/v1/feeds', { dealershipId: 'LHS-1042', feedDate: '2026-03-16', vehicles: [] });
    assert.deepEqual(conflict.body, at(openApi, ...feedsPost, ...conflictExamples, 'conflict', 'value'));

    const invalid = await api.post('/v1/feeds', requestExample('invalidCondition'));
    assert.equal(invalid.status, 422);
    assert.deepEqual(invalid.body, feedResponseExample('422'));

    const empty = await api.post('/v1/feeds', requestExample('emptyFeed'));
    assert.equal(empty.status, 201);

    const health = await api.get('/healthz');
    assert.deepEqual(health.body, at(openApi, 'paths', '/healthz', 'get', 'responses', '200', 'content', 'application/json', 'example'));
  });
});
