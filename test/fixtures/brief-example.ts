import type { ActiveVehicle, RemovedVehicle, VehicleData } from '../../src/domain/vehicle.js';

// Vehicles from the brief's March 15/16 example for dealership LHS-1042.

export const civicMarch15: VehicleData = {
  vin: '2HGFE1F71NH304352',
  stockNumber: 'H2401',
  condition: 'used',
  lotStatus: 'on_lot',
  year: 2022,
  make: 'Honda',
  model: 'Civic',
  trim: 'EX',
  price: 18495,
  mileage: 41850,
  stockedOn: '2026-02-03',
};

export const civicMarch16: VehicleData = { ...civicMarch15, price: 17995, mileage: 41910 };

export const crv: VehicleData = {
  vin: '5J6RS4H84TL012345',
  stockNumber: 'H2410',
  condition: 'new',
  lotStatus: 'on_lot',
  year: 2026,
  make: 'Honda',
  model: 'CR-V',
  trim: 'EX-L',
  price: 34250,
  mileage: 8,
  stockedOn: '2026-03-05',
};

export const accord: VehicleData = {
  vin: '1HGCY1F39TA098765',
  stockNumber: 'H2418',
  condition: 'new',
  lotStatus: 'in_transit',
  year: 2026,
  make: 'Honda',
  model: 'Accord',
  trim: 'Sport',
  price: 31480,
  mileage: 4,
  stockedOn: '2026-03-10',
};

export const pilot: VehicleData = {
  vin: '5FNYG1H78RB033333',
  stockNumber: 'H2422',
  condition: 'used',
  lotStatus: 'on_lot',
  year: 2024,
  make: 'Honda',
  model: 'Pilot',
  trim: 'TrailSport',
  price: 38900,
  mileage: 22140,
  stockedOn: '2026-03-16',
};

export function asActive(vehicle: VehicleData): ActiveVehicle {
  return { ...vehicle, status: 'active', removedOn: null };
}

export function asRemoved(vehicle: VehicleData, removedOn: string): RemovedVehicle {
  return { ...vehicle, status: 'removed', removedOn };
}
