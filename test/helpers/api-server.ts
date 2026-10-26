import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { IngestFeed } from '../../src/app/ingest-feed.js';
import { InventoryQueries } from '../../src/app/queries.js';
import { createApp } from '../../src/http/app.js';
import { FixedClock } from './fixed-clock.js';
import { openRepository } from './sqlite-repository.js';

export interface ApiResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

export interface TestServer {
  readonly clock: FixedClock;
  get(path: string, headers?: Record<string, string>): Promise<ApiResponse>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
  postRaw(path: string, rawBody: string, headers: Record<string, string>): Promise<ApiResponse>;
  closeDatabase(): void;
  close(): Promise<void>;
}

/** Real Express app over HTTP on an ephemeral port, backed by in-memory SQLite and a fixed clock. */
export async function startTestServer(today = '2026-03-16'): Promise<TestServer> {
  const { db, repository } = openRepository();
  const clock = new FixedClock(today);
  const logger = pino({ level: 'silent' });
  const app = createApp({
    ingestFeed: new IngestFeed(repository, logger),
    queries: new InventoryQueries(repository, clock),
    clock,
    logger,
    checkDatabase: () => {
      db.get('SELECT 1');
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${listeningPort(server.address())}`;
  let isDatabaseOpen = true;

  async function send(path: string, init: RequestInit): Promise<ApiResponse> {
    const response = await fetch(`${baseUrl}${path}`, init);
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text === '' ? undefined : JSON.parse(text) };
  }

  return {
    clock,
    get: (path, headers = {}) => send(path, { method: 'GET', headers }),
    post: (path, body, headers = {}) =>
      send(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } }),
    postRaw: (path, rawBody, headers) => send(path, { method: 'POST', body: rawBody, headers }),
    closeDatabase: () => {
      db.close();
      isDatabaseOpen = false;
    },
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
      if (isDatabaseOpen) {
        db.close();
      }
    },
  };
}

function listeningPort(address: AddressInfo | string | null): number {
  if (address === null || typeof address === 'string') {
    throw new Error(`Expected a TCP address, got ${String(address)}`);
  }
  return address.port;
}
