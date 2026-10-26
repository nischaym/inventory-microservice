import type { ReconcileResult } from '../domain/reconcile.js';
import type { Condition, LotStatus, StoredVehicle, VehicleStatus } from '../domain/vehicle.js';

export interface DealershipSummary {
  readonly dealershipId: string;
  readonly latestFeedDate: string;
  readonly activeVehicleCount: number;
}

/** Inventory listing filter (FR-11, FR-14). Omitted criteria do not filter. */
export interface VehicleFilter {
  readonly status: VehicleStatus;
  readonly condition?: Condition;
  readonly lotStatus?: LotStatus;
  /** Case-insensitive exact match. */
  readonly make?: string;
  /** Inclusive. */
  readonly maxPrice?: number;
}

/**
 * Persistence port. Synchronous on purpose: an `await` inside the write transaction
 * would let another request interleave and break feed serialisation (D-5).
 */
export interface InventoryRepository {
  /** Runs `fn` in one exclusive write transaction; rolls back everything if it throws. */
  inTransaction<T>(fn: (transaction: FeedTransaction) => T): T;
  listDealerships(): DealershipSummary[];
  dealershipExists(dealershipId: string): boolean;
  /** Ordered by VIN ascending (A-12). */
  listVehicles(dealershipId: string, filter: VehicleFilter): StoredVehicle[];
  findVehicle(dealershipId: string, vin: string): StoredVehicle | undefined;
}

/** A previously accepted feed: its content hash and the FEED_HASH_VERSION that produced it. */
export interface AcceptedFeed {
  readonly contentHash: string;
  readonly hashVersion: number;
}

/** Operations available only inside `inTransaction`. */
export interface FeedTransaction {
  latestFeedDate(dealershipId: string): string | undefined;
  findFeed(dealershipId: string, feedDate: string): AcceptedFeed | undefined;
  /** All of the dealership's vehicles, active and removed. */
  loadVehicles(dealershipId: string): StoredVehicle[];
  applyChanges(dealershipId: string, changes: ReconcileResult): void;
  recordFeed(dealershipId: string, feedDate: string, contentHash: string): void;
}

export interface Clock {
  /** Today's date in UTC as YYYY-MM-DD. */
  todayUtc(): string;
}
