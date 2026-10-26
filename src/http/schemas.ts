// Runtime boundary for request bodies, query strings and path parameters. Rules come from
// the domain (VIN length, calendar dates, feed-date guard) rather than being re-implemented.
import { z } from 'zod';
import type { Feed } from '../app/ingest-feed.js';
import type { VehicleFilter } from '../app/ports.js';
import { isCalendarDate, isFeedDateTooFarAhead, MAX_FEED_DATE_LEAD_DAYS } from '../domain/days.js';
import { CONDITIONS, LOT_STATUSES, VEHICLE_STATUS, VEHICLE_STATUSES } from '../domain/vehicle.js';
import { hasValidVinLength, normalizeVin, VIN_LENGTH } from '../domain/vin.js';

export interface Problem {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly problems: readonly Problem[]; readonly truncated: boolean };

export const MAX_REPORTED_PROBLEMS = 100;

function oneOf<const Values extends readonly [string, ...string[]]>(values: Values) {
  return z.enum(values, {
    error: (issue) => `Expected one of: ${values.join(', ')} (received ${JSON.stringify(issue.input) ?? 'nothing'})`,
  });
}

function text(maxLength: number) {
  return z.string().trim().min(1, 'must not be empty').max(maxLength);
}

const calendarDate = z.string().refine(isCalendarDate, {
  message: 'must be a real calendar date in YYYY-MM-DD format',
  params: { code: 'invalid_date' },
});

/** A-1: opaque and case-sensitive; trimmed, 1-128 characters, no control characters. */
const dealershipId = text(128).regex(/^\P{Cc}*$/u, 'must not contain control characters');

const vin = z
  .string()
  .refine(hasValidVinLength, {
    message: `must be ${VIN_LENGTH} characters after trimming whitespace`,
    params: { code: 'invalid_vin_length' },
  })
  .transform(normalizeVin);

const vehicleSchema = z.object({
  vin,
  stockNumber: text(50),
  condition: oneOf(CONDITIONS),
  lotStatus: oneOf(LOT_STATUSES),
  year: z.number().int().min(1000).max(9999),
  make: text(100),
  model: text(100),
  trim: text(100)
    .nullish()
    .transform((value) => value ?? null),
  price: z.number().int().positive(),
  mileage: z.number().int().nonnegative(),
  stockedOn: calendarDate,
});

// z.object strips unknown keys (A-2).
const feedSchema = z.object({
  dealershipId,
  feedDate: calendarDate,
  vehicles: z.array(vehicleSchema),
});

const vehicleListQuerySchema = z.strictObject({
  status: oneOf(VEHICLE_STATUSES).default(VEHICLE_STATUS.active),
  condition: oneOf(CONDITIONS).optional(),
  lotStatus: oneOf(LOT_STATUSES).optional(),
  make: text(100).optional(),
  maxPrice: z
    .string()
    .regex(/^\d+$/, 'must be a positive whole number')
    .transform(Number)
    .pipe(z.number().int().positive())
    .optional(),
});

export function parseFeedBody(body: unknown, todayUtc: string): ParseResult<Feed> {
  const result = feedSchema.safeParse(body);
  // Checked on the raw input so they are reported even when other fields are invalid.
  const crossFieldProblems = [...findFutureFeedDate(body, todayUtc), ...findDuplicateVins(body)];
  const problems = [...(result.success ? [] : toProblems(result.error)), ...crossFieldProblems];
  if (!result.success || problems.length > 0) {
    return failure(problems);
  }
  return { success: true, value: result.data };
}

export function parseVehicleListQuery(query: unknown): ParseResult<VehicleFilter> {
  const result = vehicleListQuerySchema.safeParse(query);
  if (!result.success) {
    return failure(toProblems(result.error));
  }
  const { status, condition, lotStatus, make, maxPrice } = result.data;
  // exactOptionalPropertyTypes: leave absent filters out rather than setting them to undefined.
  return {
    success: true,
    value: {
      status,
      ...(condition === undefined ? {} : { condition }),
      ...(lotStatus === undefined ? {} : { lotStatus }),
      ...(make === undefined ? {} : { make }),
      ...(maxPrice === undefined ? {} : { maxPrice }),
    },
  };
}

export function parseDealershipId(value: unknown): ParseResult<string> {
  return parseParameter(dealershipId, value, 'dealershipId');
}

export function parseVin(value: unknown): ParseResult<string> {
  return parseParameter(vin, value, 'vin');
}

function parseParameter(schema: z.ZodType<string, unknown>, value: unknown, name: string): ParseResult<string> {
  const result = schema.safeParse(value);
  return result.success ? { success: true, value: result.data } : failure(toProblems(result.error, [name]));
}

function findFutureFeedDate(body: unknown, todayUtc: string): Problem[] {
  if (!isRecord(body) || typeof body['feedDate'] !== 'string' || !isCalendarDate(body['feedDate'])) {
    return [];
  }
  if (!isFeedDateTooFarAhead(body['feedDate'], todayUtc)) {
    return [];
  }
  return [
    {
      path: 'feedDate',
      code: 'feed_date_in_future',
      message: `must not be more than ${MAX_FEED_DATE_LEAD_DAYS} day after today (${todayUtc}, UTC)`,
    },
  ];
}

/** Reports each repeat of a normalized VIN at the later index, pointing back to the first. */
function findDuplicateVins(body: unknown): Problem[] {
  if (!isRecord(body) || !Array.isArray(body['vehicles'])) {
    return [];
  }
  const vehicles: readonly unknown[] = body['vehicles'];
  const firstIndexByVin = new Map<string, number>();
  const problems: Problem[] = [];
  vehicles.forEach((vehicle, index) => {
    if (!isRecord(vehicle) || typeof vehicle['vin'] !== 'string' || !hasValidVinLength(vehicle['vin'])) {
      return; // missing or malformed VINs are reported by the schema
    }
    const normalizedVin = normalizeVin(vehicle['vin']);
    const firstIndex = firstIndexByVin.get(normalizedVin);
    if (firstIndex === undefined) {
      firstIndexByVin.set(normalizedVin, index);
      return;
    }
    problems.push({
      path: `vehicles[${index}].vin`,
      code: 'duplicate_vin',
      message: `Duplicates vehicles[${firstIndex}].vin (${normalizedVin})`,
    });
  });
  return problems;
}

function toProblems(error: z.ZodError, pathPrefix: readonly PropertyKey[] = []): Problem[] {
  return error.issues.map((issue) => ({
    path: formatPath([...pathPrefix, ...issue.path]),
    code: issue.code === 'custom' ? readCustomCode(issue.params) : issue.code,
    message: issue.message,
  }));
}

function readCustomCode(params: unknown): string {
  return isRecord(params) && typeof params['code'] === 'string' ? params['code'] : 'custom';
}

/** ['vehicles', 1, 'condition'] -> 'vehicles[1].condition'; [] -> ''. */
function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((segment, index) => {
      if (typeof segment === 'number') return `[${segment}]`;
      const name = String(segment);
      return index === 0 ? name : `.${name}`;
    })
    .join('');
}

function failure(problems: readonly Problem[]): ParseResult<never> {
  return {
    success: false,
    problems: problems.slice(0, MAX_REPORTED_PROBLEMS),
    truncated: problems.length > MAX_REPORTED_PROBLEMS,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
