import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, loadConfig } from '../../src/config.js';

describe('loadConfig', () => {
  test('defaults to port 8080, /data and info logging', () => {
    assert.deepEqual(loadConfig({}), { port: 8080, dataDir: '/data', logLevel: 'info' });
  });

  test('reads PORT, DATA_DIR and LOG_LEVEL', () => {
    assert.deepEqual(loadConfig({ PORT: '9090', DATA_DIR: '/tmp/inventory', LOG_LEVEL: 'debug' }), {
      port: 9090,
      dataDir: '/tmp/inventory',
      logLevel: 'debug',
    });
  });

  test('accepts PORT=0 (ephemeral port, used by tests)', () => {
    assert.equal(loadConfig({ PORT: '0' }).port, 0);
  });

  const invalidEnvironments: ReadonlyArray<readonly [string, Record<string, string>, RegExp]> = [
    ['non-numeric PORT', { PORT: 'http' }, /PORT/],
    ['fractional PORT', { PORT: '80.5' }, /PORT/],
    ['out-of-range PORT', { PORT: '65536' }, /PORT/],
    ['empty PORT', { PORT: '' }, /PORT/],
    ['empty DATA_DIR', { DATA_DIR: '' }, /DATA_DIR/],
    ['unknown LOG_LEVEL', { LOG_LEVEL: 'verbose' }, /LOG_LEVEL/],
  ];

  for (const [description, environment, expectedMessage] of invalidEnvironments) {
    test(`fails fast with a ConfigError naming the variable for ${description}`, () => {
      assert.throws(
        () => loadConfig(environment),
        (error) => error instanceof ConfigError && expectedMessage.test(error.message),
      );
    });
  }

  test('ignores unrelated environment variables', () => {
    assert.equal(loadConfig({ HOME: '/root', PATH: '/bin' }).port, 8080);
  });
});
