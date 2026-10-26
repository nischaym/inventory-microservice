import { createHash } from 'node:crypto';
import { toCanonicalVehicle, type VehicleData } from './vehicle.js';

/** Stored next to each hash; bump (and migrate) whenever the canonical form changes. */
export const FEED_HASH_VERSION = 1;

/**
 * A stored hash was made by a different canonical form, so it cannot be compared with a new
 * one: a replay would look like a conflict. Not a client error; the stored feeds need migrating.
 */
export class FeedHashVersionMismatchError extends Error {
  constructor(
    readonly dealershipId: string,
    readonly feedDate: string,
    readonly storedHashVersion: number,
    readonly currentHashVersion: number,
  ) {
    super(
      `Feed ${feedDate} for ${dealershipId} was hashed with version ${storedHashVersion}, ` +
        `but this build uses version ${currentHashVersion}; migrate stored feed hashes`,
    );
    this.name = 'FeedHashVersionMismatchError';
  }
}

/**
 * SHA-256 of a feed's vehicles in canonical form (D-3): normalized fields, fixed key
 * order, sorted by VIN. dealershipId and feedDate identify the feed, so they are not hashed.
 */
export function computeFeedHash(vehicles: readonly VehicleData[]): string {
  const canonicalVehicles = vehicles.map(toCanonicalVehicle).sort(compareByVin);
  return createHash('sha256').update(JSON.stringify(canonicalVehicles)).digest('hex');
}

/** Bytewise (UTF-16 code unit) order, independent of locale. */
function compareByVin(left: VehicleData, right: VehicleData): number {
  if (left.vin < right.vin) return -1;
  if (left.vin > right.vin) return 1;
  return 0;
}
