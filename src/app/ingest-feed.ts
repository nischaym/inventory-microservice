import { FeedConflictError, StaleFeedError } from '../domain/errors.js';
import { computeFeedHash, FEED_HASH_VERSION, FeedHashVersionMismatchError } from '../domain/feed-hash.js';
import { reconcile, summarize, type FeedSummary } from '../domain/reconcile.js';
import { VEHICLE_STATUS, type VehicleData } from '../domain/vehicle.js';
import type { FeedTransaction, InventoryRepository } from './ports.js';

/** A feed that already passed boundary validation (schema, dates, unique VINs). */
export interface Feed {
  readonly dealershipId: string;
  readonly feedDate: string;
  readonly vehicles: readonly VehicleData[];
}

export const FEED_STATUS = { applied: 'applied', replayed: 'replayed' } as const;
export const FEED_STATUSES = [FEED_STATUS.applied, FEED_STATUS.replayed] as const;
export type FeedStatus = (typeof FEED_STATUSES)[number];

export interface IngestOutcome {
  readonly dealershipId: string;
  readonly feedDate: string;
  readonly status: FeedStatus;
  readonly summary: FeedSummary;
}

export interface IngestLogger {
  warn(details: Record<string, unknown>, message: string): void;
}

/**
 * Applies one snapshot inside a single write transaction, so concurrent feeds for a
 * dealership are serialised (D-5) and any failure leaves inventory unchanged (FR-9).
 */
export class IngestFeed {
  constructor(
    private readonly repository: InventoryRepository,
    private readonly logger: IngestLogger,
  ) {}

  execute(feed: Feed): IngestOutcome {
    const { dealershipId, feedDate } = feed;
    const contentHash = computeFeedHash(feed.vehicles);

    const outcome = this.repository.inTransaction((transaction): IngestOutcome => {
      const acceptedFeed = transaction.findFeed(dealershipId, feedDate);
      if (acceptedFeed !== undefined) {
        if (acceptedFeed.hashVersion !== FEED_HASH_VERSION) {
          throw new FeedHashVersionMismatchError(dealershipId, feedDate, acceptedFeed.hashVersion, FEED_HASH_VERSION);
        }
        if (acceptedFeed.contentHash !== contentHash) {
          throw new FeedConflictError(dealershipId, feedDate); // D-2
        }
        return { dealershipId, feedDate, status: FEED_STATUS.replayed, summary: replaySummary(transaction, dealershipId) }; // D-3
      }

      const latestFeedDate = transaction.latestFeedDate(dealershipId);
      if (latestFeedDate !== undefined && feedDate < latestFeedDate) {
        throw new StaleFeedError(dealershipId, feedDate, latestFeedDate); // D-1
      }

      const changes = reconcile(transaction.loadVehicles(dealershipId), feed.vehicles, feedDate);
      transaction.applyChanges(dealershipId, changes);
      transaction.recordFeed(dealershipId, feedDate, contentHash);
      return { dealershipId, feedDate, status: FEED_STATUS.applied, summary: summarize(changes) };
    });

    if (outcome.status === FEED_STATUS.applied && feed.vehicles.length === 0) {
      this.logger.warn(
        { dealershipId, feedDate, removed: outcome.summary.removed },
        'Empty feed accepted: every active vehicle was removed (D-4)',
      );
    }
    return outcome;
  }
}

function replaySummary(transaction: FeedTransaction, dealershipId: string): FeedSummary {
  const active = transaction.loadVehicles(dealershipId).filter((vehicle) => vehicle.status === VEHICLE_STATUS.active).length;
  return { added: 0, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active };
}
