import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { civicMarch15, crv } from '../fixtures/brief-example.js';
import { createTempDirectory } from '../helpers/temp-directory.js';

interface RunningService {
  readonly process: ChildProcess;
  readonly baseUrl: string;
  readonly logLines: string[];
}

function spawnService(environment: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    env: { PATH: process.env['PATH'] ?? '', LOG_LEVEL: 'info', PORT: '0', ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Starts src/main.ts and waits for its "listening" log line to learn the port. */
async function startService(dataDir: string): Promise<RunningService> {
  const child = spawnService({ DATA_DIR: dataDir });
  const logLines: string[] = [];
  const stdout = child.stdout;
  assert.ok(stdout !== null);
  const lines = createInterface({ input: stdout });

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`service did not start; logs:\n${logLines.join('\n')}`)), 10_000);
    child.once('exit', (code) => reject(new Error(`service exited early with ${code}; logs:\n${logLines.join('\n')}`)));
    lines.on('line', (line) => {
      logLines.push(line);
      const entry: unknown = JSON.parse(line);
      if (typeof entry === 'object' && entry !== null && 'port' in entry && typeof entry.port === 'number') {
        clearTimeout(timeout);
        resolve(entry.port);
      }
    });
  });
  return { process: child, baseUrl: `http://127.0.0.1:${port}`, logLines };
}

async function stopService(service: RunningService): Promise<{ code: number | null; elapsedMs: number }> {
  const startedAt = performance.now();
  const exited = once(service.process, 'exit');
  service.process.kill('SIGTERM');
  const [code] = await exited;
  return { code: typeof code === 'number' ? code : null, elapsedMs: performance.now() - startedAt };
}

describe('service process (main.ts)', () => {
  let tempDirectory: ReturnType<typeof createTempDirectory>;

  beforeEach(() => {
    tempDirectory = createTempDirectory();
  });

  afterEach(() => {
    tempDirectory.cleanup();
  });

  test('serves requests, shuts down cleanly on SIGTERM, and keeps data across a restart (NFR-2)', async () => {
    const first = await startService(tempDirectory.path);
    const feed = { dealershipId: 'LHS-1042', feedDate: '2026-03-15', vehicles: [civicMarch15, crv] };
    const posted = await fetch(`${first.baseUrl}/v1/feeds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(feed),
    });
    assert.equal(posted.status, 201);
    const health = await fetch(`${first.baseUrl}/healthz`);
    assert.equal(health.status, 200);

    // The keep-alive connection from fetch is still open; shutdown must not wait on it.
    const stopped = await stopService(first);
    assert.equal(stopped.code, 0);
    assert.ok(stopped.elapsedMs < 3000, `shutdown took ${stopped.elapsedMs.toFixed(0)} ms`);
    assert.ok(existsSync(join(tempDirectory.path, 'inventory.db')));

    const second = await startService(tempDirectory.path);
    try {
      const listed = await fetch(`${second.baseUrl}/v1/dealerships`);
      assert.deepEqual(await listed.json(), {
        dealerships: [{ dealershipId: 'LHS-1042', latestFeedDate: '2026-03-15', activeVehicleCount: 2 }],
      });
    } finally {
      assert.equal((await stopService(second)).code, 0);
    }
  });

  test('invalid configuration fails fast with a non-zero exit and names the variable', async () => {
    const child = spawnService({ DATA_DIR: tempDirectory.path, PORT: 'eighty' });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

    const [code] = await once(child, 'exit');

    assert.equal(code, 1);
    assert.match(output, /Invalid configuration: PORT/);
  });
});
