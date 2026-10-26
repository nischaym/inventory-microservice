import type { AcceptedFeed, DealershipSummary, FeedTransaction, InventoryRepository, VehicleFilter } from '../../app/ports.js';
import { isCalendarDate } from '../../domain/days.js';
import { FEED_HASH_VERSION } from '../../domain/feed-hash.js';
import type { ReconcileResult } from '../../domain/reconcile.js';
import {
  CONDITIONS,
  LOT_STATUSES,
  VEHICLE_STATUS,
  VEHICLE_STATUSES,
  type StoredVehicle,
  type VehicleData,
  type VehicleStatus,
} from '../../domain/vehicle.js';
import { normalizeVin } from '../../domain/vin.js';
import type { SqlDatabase, SqlRow, SqlValue } from './driver.js';

const VEHICLE_COLUMNS =
  'vin, stock_number, condition, lot_status, year, make, model, trim, price, mileage, stocked_on, status, removed_on';

export class SqliteInventoryRepository implements InventoryRepository {
  private readonly feedTransaction: FeedTransaction;

  constructor(private readonly db: SqlDatabase) {
    this.feedTransaction = new SqliteFeedTransaction(db);
  }

  inTransaction<T>(fn: (transaction: FeedTransaction) => T): T {
    return this.db.transaction('immediate', () => fn(this.feedTransaction));
  }

  listDealerships(): DealershipSummary[] {
    const rows = this.db.all(
      `SELECT feeds.dealership_id,
              MAX(feeds.feed_date) AS latest_feed_date,
              (SELECT COUNT(*) FROM vehicles
                WHERE vehicles.dealership_id = feeds.dealership_id AND vehicles.status = '${VEHICLE_STATUS.active}') AS active_vehicle_count
       FROM feeds
       GROUP BY feeds.dealership_id
       ORDER BY feeds.dealership_id`,
    );
    return rows.map((row) => ({
      dealershipId: readText(row, 'dealership_id'),
      latestFeedDate: readCalendarDate(row, 'latest_feed_date'),
      activeVehicleCount: readInteger(row, 'active_vehicle_count'),
    }));
  }

  dealershipExists(dealershipId: string): boolean {
    return this.db.get('SELECT 1 FROM feeds WHERE dealership_id = ? LIMIT 1', [dealershipId]) !== undefined;
  }

  listVehicles(dealershipId: string, filter: VehicleFilter): StoredVehicle[] {
    const conditions = ['dealership_id = ?', 'status = ?'];
    const params: SqlValue[] = [dealershipId, filter.status];
    if (filter.condition !== undefined) {
      conditions.push('condition = ?');
      params.push(filter.condition);
    }
    if (filter.lotStatus !== undefined) {
      conditions.push('lot_status = ?');
      params.push(filter.lotStatus);
    }
    if (filter.make !== undefined) {
      conditions.push('make = ?'); // the column is COLLATE NOCASE
      params.push(filter.make);
    }
    if (filter.maxPrice !== undefined) {
      conditions.push('price <= ?');
      params.push(filter.maxPrice);
    }
    return this.db
      .all(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE ${conditions.join(' AND ')} ORDER BY vin`, params)
      .map(toStoredVehicle);
  }

  findVehicle(dealershipId: string, vin: string): StoredVehicle | undefined {
    const row = this.db.get(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE dealership_id = ? AND vin = ?`, [
      dealershipId,
      normalizeVin(vin),
    ]);
    return row === undefined ? undefined : toStoredVehicle(row);
  }
}

class SqliteFeedTransaction implements FeedTransaction {
  constructor(private readonly db: SqlDatabase) {}

  latestFeedDate(dealershipId: string): string | undefined {
    const row = this.db.get('SELECT MAX(feed_date) AS latest FROM feeds WHERE dealership_id = ?', [dealershipId]);
    return row === undefined || row['latest'] === null ? undefined : readCalendarDate(row, 'latest');
  }

  findFeed(dealershipId: string, feedDate: string): AcceptedFeed | undefined {
    const row = this.db.get('SELECT content_hash, hash_version FROM feeds WHERE dealership_id = ? AND feed_date = ?', [
      dealershipId,
      feedDate,
    ]);
    return row === undefined
      ? undefined
      : { contentHash: readText(row, 'content_hash'), hashVersion: readInteger(row, 'hash_version') };
  }

  loadVehicles(dealershipId: string): StoredVehicle[] {
    return this.db
      .all(`SELECT ${VEHICLE_COLUMNS} FROM vehicles WHERE dealership_id = ? ORDER BY vin`, [dealershipId])
      .map(toStoredVehicle);
  }

  applyChanges(dealershipId: string, changes: ReconcileResult): void {
    for (const vehicle of changes.added) {
      this.db.run(
        `INSERT INTO vehicles (dealership_id, ${VEHICLE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${VEHICLE_STATUS.active}', NULL)`,
        [dealershipId, ...vehicleValues(vehicle)],
      );
    }
    for (const vehicle of changes.updated) {
      this.overwriteVehicle(dealershipId, vehicle, VEHICLE_STATUS.active);
    }
    for (const vehicle of changes.reactivated) {
      this.overwriteVehicle(dealershipId, vehicle, VEHICLE_STATUS.removed);
    }
    for (const vin of changes.removedVins) {
      const { changes: updatedRows } = this.db.run(
        `UPDATE vehicles SET status = '${VEHICLE_STATUS.removed}', removed_on = ?
         WHERE dealership_id = ? AND vin = ? AND status = '${VEHICLE_STATUS.active}'`,
        [changes.feedDate, dealershipId, normalizeVin(vin)],
      );
      assertOneRowUpdated(updatedRows, 'remove', vin);
    }
  }

  /** Writes the hash version explicitly so the code, not a schema default, decides it. */
  recordFeed(dealershipId: string, feedDate: string, contentHash: string): void {
    this.db.run('INSERT INTO feeds (dealership_id, feed_date, content_hash, hash_version) VALUES (?, ?, ?, ?)', [
      dealershipId,
      feedDate,
      contentHash,
      FEED_HASH_VERSION,
    ]);
  }

  /** Replaces every field and makes the vehicle active; it must currently have `expectedStatus`. */
  private overwriteVehicle(dealershipId: string, vehicle: VehicleData, expectedStatus: VehicleStatus): void {
    const [vin, ...otherValues] = vehicleValues(vehicle);
    const { changes: updatedRows } = this.db.run(
      `UPDATE vehicles SET stock_number = ?, condition = ?, lot_status = ?, year = ?, make = ?, model = ?, trim = ?,
         price = ?, mileage = ?, stocked_on = ?, status = '${VEHICLE_STATUS.active}', removed_on = NULL
       WHERE dealership_id = ? AND vin = ? AND status = ?`,
      [...otherValues, dealershipId, vin, expectedStatus],
    );
    assertOneRowUpdated(updatedRows, expectedStatus === VEHICLE_STATUS.active ? 'update' : 'reactivate', vehicle.vin);
  }
}

/** Values in VEHICLE_COLUMNS order, without status/removed_on. VIN first. */
function vehicleValues(vehicle: VehicleData): [string, ...(string | number | null)[]] {
  return [
    normalizeVin(vehicle.vin),
    vehicle.stockNumber,
    vehicle.condition,
    vehicle.lotStatus,
    vehicle.year,
    vehicle.make,
    vehicle.model,
    vehicle.trim,
    vehicle.price,
    vehicle.mileage,
    vehicle.stockedOn,
  ];
}

function assertOneRowUpdated(updatedRows: number, operation: string, vin: string): void {
  if (updatedRows !== 1) {
    throw new Error(`applyChanges: expected to update 1 vehicle to ${operation} ${vin}, updated ${updatedRows}`);
  }
}

// Row mappers: rows arrive as unknown values and are checked column by column, so a schema
// drift or corrupt row fails loudly here instead of leaking a wrongly typed object.

export function toStoredVehicle(row: SqlRow): StoredVehicle {
  const vehicleData: VehicleData = {
    vin: readText(row, 'vin'),
    stockNumber: readText(row, 'stock_number'),
    condition: readOneOf(row, 'condition', CONDITIONS),
    lotStatus: readOneOf(row, 'lot_status', LOT_STATUSES),
    year: readInteger(row, 'year'),
    make: readText(row, 'make'),
    model: readText(row, 'model'),
    trim: readNullableText(row, 'trim'),
    price: readInteger(row, 'price'),
    mileage: readInteger(row, 'mileage'),
    stockedOn: readCalendarDate(row, 'stocked_on'),
  };
  const status = readOneOf(row, 'status', VEHICLE_STATUSES);
  if (status === VEHICLE_STATUS.active) {
    if (row['removed_on'] !== null) {
      throw new RowMappingError('removed_on', 'must be null for an active vehicle', row['removed_on']);
    }
    return { ...vehicleData, status, removedOn: null };
  }
  return { ...vehicleData, status, removedOn: readCalendarDate(row, 'removed_on') };
}

export class RowMappingError extends Error {
  constructor(column: string, expectation: string, actual: unknown) {
    super(`Malformed database row: column "${column}" ${expectation}, got ${describeValue(actual)}`);
    this.name = 'RowMappingError';
  }
}

/** JSON.stringify throws on bigint and returns undefined for undefined, so handle both. */
function describeValue(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value}n (bigint)`;
  }
  return JSON.stringify(value) ?? String(value);
}

function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new RowMappingError(column, 'must be text', value);
  }
  return value;
}

function readNullableText(row: SqlRow, column: string): string | null {
  return row[column] === null ? null : readText(row, column);
}

function readInteger(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RowMappingError(column, 'must be a safe integer', value);
  }
  return value;
}

function readCalendarDate(row: SqlRow, column: string): string {
  const value = readText(row, column);
  if (!isCalendarDate(value)) {
    throw new RowMappingError(column, 'must be a YYYY-MM-DD date', value);
  }
  return value;
}

function readOneOf<const Allowed extends string>(row: SqlRow, column: string, allowed: readonly Allowed[]): Allowed {
  const value = row[column];
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new RowMappingError(column, `must be one of ${allowed.join(', ')}`, value);
  }
  return match;
}
