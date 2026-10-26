import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { IngestFeed } from '../app/ingest-feed.js';
import type { Clock } from '../app/ports.js';
import type { InventoryQueries } from '../app/queries.js';
import { HTTP_STATUS_CLASS_START } from './status.js';
import { internalError, routeNotFound, toErrorResponse } from './problem.js';
import { createRoutes } from './routes.js';

export interface AppDependencies {
  readonly ingestFeed: IngestFeed;
  readonly queries: InventoryQueries;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Throws when the database is not usable. */
  readonly checkDatabase: () => void;
}

const REQUEST_ID_HEADER = 'x-request-id';
const SAFE_REQUEST_ID = /^[\w.:-]{1,128}$/;

/** Builds the Express app without listening, so tests can drive it on an ephemeral port. */
export function createApp({ ingestFeed, queries, clock, logger, checkDatabase }: AppDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    pinoHttp({
      logger,
      genReqId: assignRequestId,
      customLogLevel: (_req, res, error) => {
        if (error !== undefined || res.statusCode >= HTTP_STATUS_CLASS_START.serverError) return 'error';
        return res.statusCode >= HTTP_STATUS_CLASS_START.clientError ? 'warn' : 'info';
      },
      autoLogging: { ignore: (req) => req.url === '/healthz' },
    }),
  );

  app.use(createRoutes({ ingestFeed, queries, clock, checkDatabase }));

  app.use((req: Request, res: Response) => {
    const notFound = routeNotFound(req.method, req.path);
    res.status(notFound.status).json(notFound.body);
  });

  app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const expected = toErrorResponse(error);
    if (expected !== undefined) {
      res.status(expected.status).json(expected.body);
      return;
    }
    // Full details go to the log (with the request id); the client gets no internals.
    req.log.error({ err: error }, 'Unhandled error');
    res.status(internalError.status).json(internalError.body);
  });

  return app;
}

/** Reuses a well-formed incoming x-request-id (for tracing across services), else generates one. */
function assignRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const requestId = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}
