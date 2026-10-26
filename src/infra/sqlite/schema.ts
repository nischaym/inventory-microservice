import type { SqlDatabase } from './driver.js';

// WAL sidecar files (-wal, -shm) live next to the database file, inside the data volume.
// synchronous=FULL makes each commit durable across a container stop.
const CONNECTION_PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = FULL;
  PRAGMA busy_timeout = 5000;
`;

const SCHEMA = `
  -- One row per accepted feedDate. A dealership is "known" iff it has a row here (FR-2).
  -- hash_version has no default: the repository writes FEED_HASH_VERSION on every insert.
  CREATE TABLE IF NOT EXISTS feeds (
    dealership_id TEXT NOT NULL,
    feed_date     TEXT NOT NULL,
    content_hash  TEXT NOT NULL,
    hash_version  INTEGER NOT NULL,
    PRIMARY KEY (dealership_id, feed_date)
  ) STRICT, WITHOUT ROWID;

  -- Current state only: one row per (dealership, VIN), no per-feed history (D-7).
  CREATE TABLE IF NOT EXISTS vehicles (
    dealership_id TEXT NOT NULL,
    vin           TEXT NOT NULL,
    stock_number  TEXT NOT NULL,
    condition     TEXT NOT NULL CHECK (condition IN ('new', 'used', 'certified')),
    lot_status    TEXT NOT NULL CHECK (lot_status IN ('on_lot', 'in_transit')),
    year          INTEGER NOT NULL,
    make          TEXT NOT NULL COLLATE NOCASE,
    model         TEXT NOT NULL,
    trim          TEXT,
    price         INTEGER NOT NULL CHECK (price > 0),
    mileage       INTEGER NOT NULL CHECK (mileage >= 0),
    stocked_on    TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    removed_on    TEXT,
    PRIMARY KEY (dealership_id, vin),
    CHECK ((status = 'active' AND removed_on IS NULL)
        OR (status = 'removed' AND removed_on IS NOT NULL))
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX IF NOT EXISTS vehicles_by_status ON vehicles (dealership_id, status, vin);
`;

/** Applies connection PRAGMAs and creates tables if missing. Safe to run on every start. */
export function initializeSchema(db: SqlDatabase): void {
  db.exec(CONNECTION_PRAGMAS);
  db.exec(SCHEMA);
}
