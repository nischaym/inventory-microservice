import { normalizeVin } from './vin.js';
import { hasSameVehicleData, VEHICLE_STATUS, type StoredVehicle, type VehicleData } from './vehicle.js';

/**
 * Changes needed to make a dealership's stored inventory match one snapshot.
 * Vehicle lists carry the incoming data to write as active; VIN lists need no data.
 */
export interface ReconcileResult {
  readonly feedDate: string;
  /** VIN never seen for the dealership (FR-3). */
  readonly added: readonly VehicleData[];
  /** Active and present, with at least one field changed (FR-4, A-6). */
  readonly updated: readonly VehicleData[];
  /** Removed and present again; all fields, including stockedOn, come from the feed (FR-7). */
  readonly reactivated: readonly VehicleData[];
  /** Active and present with identical data; not rewritten (A-6). */
  readonly unchangedVins: readonly string[];
  /** Active and absent; become removed with removedOn = feedDate (FR-5). */
  readonly removedVins: readonly string[];
}

export interface FeedSummary {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly reactivated: number;
  readonly active: number;
}

/**
 * Pure snapshot diff. `incoming` must already be validated: one entry per normalized VIN.
 * Vehicles already removed and still absent are left untouched, keeping their removedOn.
 */
export function reconcile(
  existing: readonly StoredVehicle[],
  incoming: readonly VehicleData[],
  feedDate: string,
): ReconcileResult {
  const existingByVin = new Map(existing.map((vehicle) => [normalizeVin(vehicle.vin), vehicle]));
  const incomingVins = new Set<string>();

  const added: VehicleData[] = [];
  const updated: VehicleData[] = [];
  const reactivated: VehicleData[] = [];
  const unchangedVins: string[] = [];

  for (const vehicle of incoming) {
    const vin = normalizeVin(vehicle.vin);
    if (incomingVins.has(vin)) {
      throw new Error(`reconcile: duplicate VIN ${vin} in incoming feed; validation must reject it first`);
    }
    incomingVins.add(vin);

    const current = existingByVin.get(vin);
    if (current === undefined) {
      added.push(vehicle);
    } else if (current.status === VEHICLE_STATUS.removed) {
      reactivated.push(vehicle);
    } else if (hasSameVehicleData(current, vehicle)) {
      unchangedVins.push(vin);
    } else {
      updated.push(vehicle);
    }
  }

  const removedVins = existing
    .filter((vehicle) => vehicle.status === VEHICLE_STATUS.active && !incomingVins.has(normalizeVin(vehicle.vin)))
    .map((vehicle) => normalizeVin(vehicle.vin));

  return { feedDate, added, updated, reactivated, unchangedVins, removedVins };
}

export function summarize(result: ReconcileResult): FeedSummary {
  const added = result.added.length;
  const updated = result.updated.length;
  const unchanged = result.unchangedVins.length;
  const reactivated = result.reactivated.length;
  return {
    added,
    updated,
    unchanged,
    removed: result.removedVins.length,
    reactivated,
    active: added + updated + unchanged + reactivated,
  };
}
