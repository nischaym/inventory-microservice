// Maps failures to the documented error envelope: { error: { code, message, ...context } }.
import {
  DOMAIN_ERROR_CODES,
  FeedConflictError,
  NotFoundError,
  StaleFeedError,
  type DomainErrorCode,
} from '../domain/errors.js';
import { MAX_BODY_SIZE_MEGABYTES } from './limits.js';
import type { Problem } from './schemas.js';
import { HTTP_STATUS, HTTP_STATUS_CLASS_START } from './status.js';

/** Request-level codes (spec §5.6). Wire values are part of the API contract. */
export const HTTP_ERROR_CODES = {
  validationFailed: 'VALIDATION_FAILED',
  invalidRequest: 'INVALID_REQUEST',
  invalidJson: 'INVALID_JSON',
  unsupportedMediaType: 'UNSUPPORTED_MEDIA_TYPE',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  routeNotFound: DOMAIN_ERROR_CODES.notFound,
  internal: 'INTERNAL',
} as const;
type HttpErrorCode = (typeof HTTP_ERROR_CODES)[keyof typeof HTTP_ERROR_CODES];
export type ErrorCode = DomainErrorCode | HttpErrorCode;

export interface ErrorResponse {
  readonly status: number;
  readonly body: { readonly error: Readonly<Record<string, unknown>> & { readonly code: ErrorCode; readonly message: string } };
}

function errorResponse(status: number, code: ErrorCode, message: string, context: Record<string, unknown> = {}): ErrorResponse {
  return { status, body: { error: { code, message, ...context } } };
}

export function validationFailed(problems: readonly Problem[], truncated: boolean): ErrorResponse {
  const count = truncated ? `More than ${problems.length} problems` : `${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}`;
  return errorResponse(HTTP_STATUS.unprocessableEntity, HTTP_ERROR_CODES.validationFailed, `Feed rejected: ${count} found. No inventory was changed.`, {
    details: problems,
    truncated,
  });
}

export function invalidRequest(problems: readonly Problem[], truncated: boolean): ErrorResponse {
  return errorResponse(HTTP_STATUS.badRequest, HTTP_ERROR_CODES.invalidRequest, 'Invalid path or query parameters.', { details: problems, truncated });
}

export function unsupportedMediaType(): ErrorResponse {
  return errorResponse(HTTP_STATUS.unsupportedMediaType, HTTP_ERROR_CODES.unsupportedMediaType, 'Content-Type must be application/json.');
}

export function routeNotFound(method: string, path: string): ErrorResponse {
  return errorResponse(HTTP_STATUS.notFound, HTTP_ERROR_CODES.routeNotFound, `No route for ${method} ${path}`);
}

export const internalError: ErrorResponse = errorResponse(HTTP_STATUS.internalServerError, HTTP_ERROR_CODES.internal, 'Internal server error');

/** Expected failures (domain rules, body parsing). Returns undefined for anything unexpected. */
export function toErrorResponse(error: unknown): ErrorResponse | undefined {
  if (error instanceof StaleFeedError) {
    return errorResponse(HTTP_STATUS.conflict, error.code, error.message, { latestFeedDate: error.latestFeedDate });
  }
  if (error instanceof FeedConflictError) {
    return errorResponse(HTTP_STATUS.conflict, error.code, error.message, { feedDate: error.feedDate });
  }
  if (error instanceof NotFoundError) {
    return errorResponse(HTTP_STATUS.notFound, error.code, error.message);
  }
  return fromBodyParserError(error);
}

/** express.json() reports failures as errors with a string `type` (see body-parser docs). */
function fromBodyParserError(error: unknown): ErrorResponse | undefined {
  if (!(error instanceof Error) || !('type' in error) || typeof error.type !== 'string') {
    return undefined;
  }
  switch (error.type) {
    case 'entity.parse.failed':
      return errorResponse(HTTP_STATUS.badRequest, HTTP_ERROR_CODES.invalidJson, 'Request body is not valid JSON.');
    case 'entity.too.large':
      return errorResponse(
        HTTP_STATUS.payloadTooLarge,
        HTTP_ERROR_CODES.payloadTooLarge,
        `Request body exceeds the ${MAX_BODY_SIZE_MEGABYTES} MB limit.`,
      );
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return errorResponse(HTTP_STATUS.unsupportedMediaType, HTTP_ERROR_CODES.unsupportedMediaType, error.message);
    default:
      return 'status' in error && typeof error.status === 'number' && error.status >= HTTP_STATUS_CLASS_START.clientError && error.status < HTTP_STATUS_CLASS_START.serverError
        ? errorResponse(HTTP_STATUS.badRequest, HTTP_ERROR_CODES.invalidRequest, error.message)
        : undefined;
  }
}
