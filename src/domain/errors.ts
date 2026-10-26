/** Wire values are part of the API contract (spec §5.6); never change one in place. */
export const DOMAIN_ERROR_CODES = {
  staleFeed: 'STALE_FEED',
  feedConflict: 'FEED_CONFLICT',
  notFound: 'NOT_FOUND',
} as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES];

/** Base for expected business-rule failures; the HTTP layer maps `code` to a status. */
export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;
}

/** D-1: feedDate is earlier than the latest accepted feed and was never accepted itself. */
export class StaleFeedError extends DomainError {
  readonly code = DOMAIN_ERROR_CODES.staleFeed;

  constructor(
    readonly dealershipId: string,
    readonly feedDate: string,
    readonly latestFeedDate: string,
  ) {
    super(`Feed ${feedDate} for ${dealershipId} is older than the latest accepted feed ${latestFeedDate}`);
    this.name = 'StaleFeedError';
  }
}

/** D-2: a feed for this date was already accepted with different content. */
export class FeedConflictError extends DomainError {
  readonly code = DOMAIN_ERROR_CODES.feedConflict;

  constructor(
    readonly dealershipId: string,
    readonly feedDate: string,
  ) {
    super(`A different feed for ${dealershipId} on ${feedDate} was already accepted`);
    this.name = 'FeedConflictError';
  }
}

export class NotFoundError extends DomainError {
  readonly code = DOMAIN_ERROR_CODES.notFound;

  constructor(
    readonly resource: 'dealership' | 'vehicle',
    readonly identifier: string,
  ) {
    super(`${resource} not found: ${identifier}`);
    this.name = 'NotFoundError';
  }
}
