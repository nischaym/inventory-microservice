import { normalizeVin } from './vin.js';

export const CONDITIONS = ['new', 'used', 'certified'] as const;
export type Condition = (typeof CONDITIONS)[number];

export const LOT_STATUSES = ['on_lot', 'in_transit'] as const;
export type LotStatus = (typeof LOT_STATUSES)[number];

export const VEHICLE_STATUS = { active: 'active', removed: 'removed' } as const;
export const VEHICLE_STATUSES = [VEHICLE_STATUS.active, VEHICLE_STATUS.removed] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/** What a feed carries for one vehicle, after boundary normalization. */
export interface VehicleData {
  readonly vin: string;
  readonly stockNumber: string;
  readonly condition: Condition;
  readonly lotStatus: LotStatus;
  readonly year: number;
  readonly make: string;
  readonly model: string;
  readonly trim: string | null;
  readonly price: number;
  readonly mileage: number;
  readonly stockedOn: string;
}

export type ActiveVehicle = VehicleData & { readonly status: typeof VEHICLE_STATUS.active; readonly removedOn: null };
export type RemovedVehicle = VehicleData & { readonly status: typeof VEHICLE_STATUS.removed; readonly removedOn: string };
export type StoredVehicle = ActiveVehicle | RemovedVehicle;

/**
 * Normalized copy holding only the VehicleData fields, in a fixed key order.
 * Typed as VehicleData, so adding a field fails compilation here until it is listed.
 * Used for equality (reconcile) and hashing (feed-hash), so both see the same fields.
 */
export function toCanonicalVehicle(vehicle: VehicleData): VehicleData {
  return {
    vin: normalizeVin(vehicle.vin),
    stockNumber: vehicle.stockNumber.trim(),
    condition: vehicle.condition,
    lotStatus: vehicle.lotStatus,
    year: vehicle.year,
    make: vehicle.make.trim(),
    model: vehicle.model.trim(),
    trim: vehicle.trim === null ? null : vehicle.trim.trim(),
    price: vehicle.price,
    mileage: vehicle.mileage,
    stockedOn: vehicle.stockedOn,
  };
}

export function hasSameVehicleData(left: VehicleData, right: VehicleData): boolean {
  return JSON.stringify(toCanonicalVehicle(left)) === JSON.stringify(toCanonicalVehicle(right));
}
