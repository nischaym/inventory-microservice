// Composition root: config, database, use cases, HTTP server, graceful shutdown.
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pino, type Logger } from 'pino';
import { IngestFeed } from './app/ingest-feed.js';
import { InventoryQueries } from './app/queries.js';
import { loadConfig, type Config } from './config.js';
import { createApp } from './http/app.js';
import { openSqliteDatabase, type SqlDatabase } from './infra/sqlite/driver.js';
import { SqliteInventoryRepository } from './infra/sqlite/repository.js';
import { initializeSchema } from './infra/sqlite/schema.js';
import { systemClock } from './infra/system-clock.js';

const SHUTDOWN_GRACE_MS = 5000;

function start(config: Config, logger: Logger): void {
  mkdirSync(config.dataDir, { recursive: true });
  const db = openSqliteDatabase(join(config.dataDir, 'inventory.db'));
  initializeSchema(db);

  const repository = new SqliteInventoryRepository(db);
  const app = createApp({
    ingestFeed: new IngestFeed(repository, logger),
    queries: new InventoryQueries(repository, systemClock),
    clock: systemClock,
    logger,
    checkDatabase: () => {
      db.get('SELECT 1');
    },
  });

  const server = app.listen(config.port, () => {
    logger.info({ port: listeningPort(server.address()), dataDir: config.dataDir }, 'Inventory service listening');
  });
  server.on('error', (error) => {
    logger.fatal({ err: error }, 'HTTP server failed');
    db.close();
    process.exit(1);
  });

  const shutdown = createShutdown(server, db, logger);
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Stops accepting connections, lets in-flight requests finish (up to SHUTDOWN_GRACE_MS),
 * then closes the database, which checkpoints the WAL. Node runs as PID 1 in the container,
 * so without this `docker stop` would wait 10 s and SIGKILL.
 */
function createShutdown(server: Server, db: SqlDatabase, logger: Logger): (signal: string) => void {
  let isShuttingDown = false;
  return (signal) => {
    if (isShuttingDown) {
      return;
    }
    isShuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceCloseTimer = setTimeout(() => {
      logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'In-flight requests did not finish in time; closing connections');
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    forceCloseTimer.unref();

    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error !== undefined) {
        logger.error({ err: error }, 'Error while closing the HTTP server');
      }
      try {
        db.close();
      } catch (closeError: unknown) {
        logger.error({ err: closeError }, 'Error while closing the database');
        process.exit(1);
      }
      logger.info('Shutdown complete');
      process.exit(0);
    });
    // Idle keep-alive sockets would otherwise hold server.close() open.
    server.closeIdleConnections();
  };
}

function listeningPort(address: AddressInfo | string | null): number | string | null {
  return address !== null && typeof address === 'object' ? address.port : address;
}

const bootstrapLogger = pino();
try {
  const config = loadConfig(process.env);
  const logger = pino({ level: config.logLevel });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
  start(config, logger);
} catch (error: unknown) {
  bootstrapLogger.fatal({ err: error }, error instanceof Error ? error.message : 'Startup failed');
  process.exit(1);
}
