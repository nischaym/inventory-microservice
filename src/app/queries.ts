import { daysInInventory } from '../domain/days.js';
import { NotFoundError } from '../domain/errors.js';
import { VEHICLE_STATUS, type StoredVehicle } from '../domain/vehicle.js';
import type { Clock, DealershipSummary, InventoryRepository, VehicleFilter } from './ports.js';

export type VehicleView = StoredVehicle & { readonly daysInInventory: number };

export class InventoryQueries {
  constructor(
    private readonly repository: InventoryRepository,
    private readonly clock: Clock,
  ) {}

  listDealerships(): DealershipSummary[] {
    return this.repository.listDealerships();
  }

  /** A-9: an unknown dealership is NotFound rather than an empty list. */
  listVehicles(dealershipId: string, filter: VehicleFilter): VehicleView[] {
    this.requireKnownDealership(dealershipId);
    const today = this.clock.todayUtc();
    return this.repository.listVehicles(dealershipId, filter).map((vehicle) => toView(vehicle, today));
  }

  findVehicle(dealershipId: string, vin: string): VehicleView {
    this.requireKnownDealership(dealershipId);
    const vehicle = this.repository.findVehicle(dealershipId, vin);
    if (vehicle === undefined) {
      throw new NotFoundError('vehicle', vin.trim());
    }
    return toView(vehicle, this.clock.todayUtc());
  }

  private requireKnownDealership(dealershipId: string): void {
    if (!this.repository.dealershipExists(dealershipId)) {
      throw new NotFoundError('dealership', dealershipId);
    }
  }
}

/** FR-13: active vehicles count to today; removed ones freeze at the feed that removed them. */
function toView(vehicle: StoredVehicle, today: string): VehicleView {
  const referenceDate = vehicle.status === VEHICLE_STATUS.active ? today : vehicle.removedOn;
  return { ...vehicle, daysInInventory: daysInInventory(vehicle.stockedOn, referenceDate) };
}
