import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { FEED_STATUS, type IngestFeed } from '../app/ingest-feed.js';
import type { Clock } from '../app/ports.js';
import type { InventoryQueries, VehicleView } from '../app/queries.js';
import { MAX_BODY_SIZE_BYTES } from './limits.js';
import { HTTP_STATUS } from './status.js';
import { invalidRequest, unsupportedMediaType, validationFailed, type ErrorResponse } from './problem.js';
import { parseDealershipId, parseFeedBody, parseVehicleListQuery, parseVin } from './schemas.js';

export interface RouteDependencies {
  readonly ingestFeed: IngestFeed;
  readonly queries: InventoryQueries;
  readonly clock: Clock;
  readonly checkDatabase: () => void;
}

export function createRoutes({ ingestFeed, queries, clock, checkDatabase }: RouteDependencies): Router {
  const router = Router();

  router.post(
    '/v1/feeds',
    requireJsonContentType,
    // strict: false so a top-level array/null/string reaches validation and is reported at path "".
    express.json({ limit: MAX_BODY_SIZE_BYTES, strict: false }),
    (req, res) => {
      const parsed = parseFeedBody(req.body, clock.todayUtc());
      if (!parsed.success) {
        send(res, validationFailed(parsed.problems, parsed.truncated));
        return;
      }
      const outcome = ingestFeed.execute(parsed.value);
      res.status(outcome.status === FEED_STATUS.applied ? HTTP_STATUS.created : HTTP_STATUS.ok).json(outcome);
    },
  );

  router.get('/v1/dealerships', (_req, res) => {
    res.json({ dealerships: queries.listDealerships() });
  });

  router.get('/v1/dealerships/:dealershipId/vehicles', (req, res) => {
    const dealershipId = parseDealershipId(req.params.dealershipId);
    const filter = parseVehicleListQuery(req.query);
    if (!dealershipId.success) {
      send(res, invalidRequest(dealershipId.problems, dealershipId.truncated));
      return;
    }
    if (!filter.success) {
      send(res, invalidRequest(filter.problems, filter.truncated));
      return;
    }
    const vehicles = queries.listVehicles(dealershipId.value, filter.value).map(toVehicleResponse);
    res.json({ vehicles, count: vehicles.length });
  });

  router.get('/v1/dealerships/:dealershipId/vehicles/:vin', (req, res) => {
    const dealershipId = parseDealershipId(req.params.dealershipId);
    const vin = parseVin(req.params.vin);
    if (!dealershipId.success) {
      send(res, invalidRequest(dealershipId.problems, dealershipId.truncated));
      return;
    }
    if (!vin.success) {
      send(res, invalidRequest(vin.problems, vin.truncated));
      return;
    }
    res.json(toVehicleResponse(queries.findVehicle(dealershipId.value, vin.value)));
  });

  router.get('/healthz', (req, res) => {
    try {
      checkDatabase();
    } catch (error: unknown) {
      req.log.error({ err: error }, 'Health check failed: database unavailable');
      res.status(HTTP_STATUS.serviceUnavailable).json({ status: 'unavailable' });
      return;
    }
    res.json({ status: 'ok' });
  });

  return router;
}

function requireJsonContentType(req: Request, res: Response, next: NextFunction): void {
  if (req.is('application/json') === 'application/json') {
    next();
    return;
  }
  send(res, unsupportedMediaType());
}

function send(res: Response, errorResponse: ErrorResponse): void {
  res.status(errorResponse.status).json(errorResponse.body);
}

/** The documented representation, field by field, so internal fields never leak. */
function toVehicleResponse(vehicle: VehicleView) {
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
    status: vehicle.status,
    removedOn: vehicle.removedOn,
    daysInInventory: vehicle.daysInInventory,
  };
}
