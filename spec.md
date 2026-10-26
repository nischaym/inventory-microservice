# Inventory Service — Technical Specification

| | |
|---|---|
| **Status** | Draft for review |
| **Author** | Nischay |
| **Date** | 2026-10-25 |
| **Stack** | TypeScript, Node.js, Express 5, Zod, SQLite (`node:sqlite`), Pino |
| **Source brief** | `inventory-service-exercise.md` |
| **Timebox** | ~2 h target, 4 h hard cap |

---

## 1. Background

Dealerships' inventory providers send a scheduled export of each dealership's vehicle inventory. Every export is a **complete snapshot** of the vehicles the dealership currently wants published, not a delta. Vehicles that are sold or pulled disappear from the next snapshot.

Staff need one service that:

- ingests those snapshots for many dealerships,
- answers "what do we have, what did we have, and how long has it been here?",
- keeps an accurate record of vehicles that left inventory.

This is a take-home exercise. It is evaluated, in order, on: correctness of snapshot semantics, domain modeling, verification, judgment (documented decisions and trade-offs), operability (container), and communication. Code volume and UI polish are explicitly not evaluated, so this spec optimises for a small, correct, well-verified design.

### 1.1 Glossary

| Term | Meaning |
|---|---|
| **Feed** | One JSON snapshot for one dealership on one `feedDate`. |
| **Active** | Vehicle present in the dealership's most recently accepted feed. Both `on_lot` and `in_transit` are for sale. |
| **Removed** | Vehicle seen in an earlier feed but absent from the most recently accepted feed. |
| **Latest feed** | The accepted feed with the greatest `feedDate` for a dealership. |
| **Replay** | Re-submission of a previously accepted feed (same dealership, same `feedDate`, same content). |

---

## 2. Requirements

IDs are used in the traceability tables in §6 and §9.

### 2.1 Functional

| ID | Requirement |
|---|---|
| FR-1 | Ingest a dealership's feed from a JSON request body. |
| FR-2 | A dealership becomes known when its first feed is accepted. A feed affects only the dealership it names. |
| FR-3 | A VIN never seen before for the dealership becomes a new active vehicle. |
| FR-4 | A VIN already active is updated with the feed's latest data. |
| FR-5 | An active VIN missing from the feed becomes removed. |
| FR-6 | A removed vehicle stays retrievable by VIN. |
| FR-7 | A removed VIN present in a later feed becomes active again; all details, including `stockedOn`, come from that feed. |
| FR-8 | Submitting the same feed more than once does not change inventory (idempotent). |
| FR-9 | Feed acceptance is all-or-nothing: any invalid part rejects the whole feed and leaves inventory unchanged. |
| FR-10 | Rejections explain what is wrong and where. |
| FR-11 | View a dealership's active inventory, filterable by condition, lot status, make and maximum price, in a stable documented order. |
| FR-12 | Find a vehicle (active or removed) by VIN. |
| FR-13 | Every returned vehicle reports `daysInInventory`: calendar days from `stockedOn` to the reference date. Active: today (UTC). Removed: `feedDate` of the feed in which it was first absent (value freezes). |
| FR-14 | List removed vehicles for a dealership. |
| FR-15 | List known dealerships with each one's latest accepted `feedDate` and active-vehicle count. |
| FR-16 | VINs compare ignoring surrounding whitespace and letter case. |

### 2.2 Data rules (from the brief, plus decisions in §3)

- All fields required except `trim`.
- `vin`: exactly 17 characters after trimming; upper-cased for comparison and storage. No check-digit or character-set enforcement (decision D-9).
- `condition`: `new | used | certified`. `lotStatus`: `on_lot | in_transit`.
- `year`: four-digit integer. `price`: positive integer. `mileage`: non-negative integer.
- Dates: `YYYY-MM-DD`, must be real calendar dates.
- A VIN may appear once per feed (after normalization); duplicates invalidate the feed.
- `stockNumber` is a label, not an identifier. It is never used for matching.

### 2.3 Non-functional / container

| ID | Requirement |
|---|---|
| NFR-1 | No external database or service; no internet needed at runtime; no credentials. |
| NFR-2 | Data persists across container stop/start using the `/data` volume. |
| NFR-3 | `linux/amd64` OCI image; default command starts the service on port **8080**. |
| NFR-4 | Runs as non-root under `--read-only --tmpfs /tmp --cap-drop ALL --memory 512m --cpus 1 -v inventory-data:/data`. Only `/data` and `/tmp` are writable. |
| NFR-5 | A documented health check. |
| NFR-6 | Automated tests. |
| NFR-7 | Docs: run/build/test, API, architecture and decisions, scale-up notes, assumptions and limitations. |
| NFR-8 | A runnable script that replays the March 15 and 16 example against the running container and prints resulting inventory. |
| NFR-9 | `AI_DEVELOPMENT.md` (report on how AI was used; not covered by this spec beyond listing it as a deliverable). |

---

## 3. Decisions and assumptions

Each item states the choice, why, and the trade-off. D-1 to D-5 cover the four decisions the brief leaves open plus the replay case that follows from them; D-6 to D-10 are confirmed design choices. A-x items are smaller defaults I picked, flagged so you can overrule them.

### 3.1 Decisions left open by the brief

| # | Situation | Decision | Rationale / trade-off |
|---|---|---|---|
| **D-1** | `feedDate` **earlier** than the dealership's latest accepted feed | **Reject, `409 STALE_FEED`**, inventory unchanged, when that date has never been accepted. *If that exact date was already accepted:* identical content is a replay (D-3); different content is `FEED_CONFLICT` (D-2). | Snapshot semantics assume a monotonic timeline: applying an old snapshot after a newer one would wrongly remove or revive vehicles. Rebuilding history from out-of-order feeds is out of scope. Trade-off: a provider that delivers late feeds out of order must resend in order. |
| **D-2** | **Same** `feedDate` (the latest, or any earlier accepted date), **different** content | **Reject, `409 FEED_CONFLICT`**. An accepted day is immutable. | Keeps `removedOn` and `daysInInventory` of removed vehicles stable. Trade-off: providers cannot correct a bad feed for a day already accepted; they must send a corrected feed with a later date. |
| **D-3** | **Same** `feedDate`, **same** content (replay) | **`200`, no changes**, response `status: "replayed"`. | Satisfies FR-8 and makes client retries safe. "Same content" means semantically equal after normalization (case/whitespace in VINs, vehicle order, omitted vs `null` `trim`), compared by hash. |
| **D-4** | Empty `vehicles` array | **Accept**: every active vehicle becomes removed. Logs a `warn`. | A snapshot of zero is a valid snapshot (dealership sold out). Trade-off: a buggy provider can blank a dealership; the previous state is recoverable only by a later feed. The `warn` log and `summary.removed` count are the safety net. |
| **D-5** | Two feeds for the same dealership at the same time | **Serialised.** Each ingest is one synchronous SQLite transaction opened with `BEGIN IMMEDIATE`. The second feed is evaluated against the state left by the first, so exactly the D-1/D-2/D-3 rules decide its outcome. | `node:sqlite` is synchronous, so within one process a feed's read-diff-write cannot interleave with another. `BEGIN IMMEDIATE` also takes the write lock up front, so two processes sharing the file still serialise (plus `busy_timeout`) defence in depth only; multiple instances are unsupported, see §8. |

### 3.2 Design choices

| # | Choice | Rationale / trade-off |
|---|---|---|
| **D-6** | **Storage: SQLite via `node:sqlite`**, file at `/data/inventory.db`, WAL mode. All driver-specific code lives in **one file** (`src/infra/sqlite/driver.ts`) behind a small `SqlDatabase` interface, so swapping to `better-sqlite3` is a one-file change (+ dependency + Dockerfile build step). | Built into Node (no native build in Docker), transactions give FR-9 for free, SQL gives stable ordering and filtering. Risk: `node:sqlite` is still flagged experimental on some Node versions (emits a warning). The driver seam is the mitigation. See §5.4. |
| **D-7** | **Data model: current-state table** (one row per `(dealershipId, vin)`) with `status` and `removedOn`, plus a small `feeds` log (one row per accepted `(dealershipId, feedDate)` holding a content hash). No per-feed vehicle history. | Covers every requirement with minimal storage and query complexity. Trade-off: no audit trail of past prices or statuses; documented as a limitation. The `feeds` log is what makes replay detection (D-3) work for any past date, not only the latest. |
| **D-8** | **HTTP: Express 5 + Zod**, Pino structured logging (`pino-http`). | Familiar, async handlers propagate errors in Express 5. Zod issue paths map directly to the "what and where" error requirement (FR-10). |
| **D-9** | **VIN validation is a 17-character length check only** (after trimming). The check digit and character set are not enforced. | Chosen explicitly. The brief makes check-digit validation optional, and rejecting a whole feed over one unusual VIN is costly (non-North-American VINs often fail the digit; synthetic test data would too). All four brief VINs do pass the ISO 3779 check digit, so the rule can be added later as one pure function (`domain/vin.ts`) without changing any other code. Lookup by VIN normalizes the same way. |
| **D-10** | **Future-date guard.** A `feedDate` more than 1 day after today (UTC) → `422 VALIDATION_FAILED`, path `feedDate`. | Without it, one bad date (e.g. 2099) makes every later real feed `STALE_FEED` with no recovery path. The +1 day tolerance absorbs time-zone skew. Uses the injected `Clock`, so tests control it. |

### 3.3 Smaller assumptions (A-x)

| # | Assumption | Why |
|---|---|---|
| A-1 | `dealershipId` is an opaque, **case-sensitive** string: trimmed, 1–128 characters, no control characters. It is URL-encoded in paths. | The brief treats it as an identifier without a format; a strict regex could reject real IDs. |
| A-2 | **Unknown JSON keys are ignored** (stripped, not stored). Known fields remain strictly validated. | A provider adding a harmless field must not break ingestion. Trade-off: a typo in an *optional* field name (e.g. `trimm`) is silently dropped. Flip to strict by changing one Zod option. |
| A-3 | `year` accepts any four-digit integer (1000–9999). No further range check. | The brief only says four digits; a tighter range risks rejecting legitimate data. |
| A-4 | `make`, `model`, `trim`, `stockNumber` are trimmed, non-empty strings (max 100 chars; `stockNumber` max 50). `trim` may be omitted or `null` (both stored as null); an empty or whitespace-only string is invalid. Stored as provided (trimmed), not case-folded. `make` filtering is **case-insensitive** (ASCII). | Preserves provider display values while making the filter forgiving. |
| A-5 | A `stockedOn` after `feedDate` is accepted; `daysInInventory` is clamped at `0` (never negative). Future `feedDate`s are governed by D-10. | The brief does not forbid it, and rejecting could discard real data (e.g. in-transit vehicles pre-registered). Trade-off: clamping can hide a provider data error. |
| A-6 | "Updated" in the feed summary means at least one stored field changed. A re-listed active vehicle with identical data is `unchanged` and is not rewritten. | Gives the summary counts a testable meaning. |
| A-7 | The reference date for active vehicles is the **server clock date in UTC**, read through an injectable `Clock`. | Required by the brief; the injectable clock makes tests deterministic. |
| A-8 | Response `price` is whole dollars (integer), as ingested. No currency field. | Matches the brief. |
| A-9 | Listing a dealership that has never submitted a feed returns `404`, not an empty list. | The dealership is not "known" yet (FR-2). |
| A-10 | Request body limit is 10 MB (`413` beyond). | A feed of ~30k vehicles at ~300 B each is ~9 MB; keeps parsing inside the 512 MB limit. Revisit with streaming (§8). |
| A-11 | Package manager is **npm** (lockfile committed); runtime image is **Node 24 LTS, Debian slim** (minimum supported: Node 22.13); tests use the built-in `node:test` runner; strict TypeScript, no `any`, no `as` casts, ESM with `NodeNext`. | Debian (glibc) keeps the `better-sqlite3` swap path easy. |
| A-12 | Inventory ordering is **VIN ascending** (uppercase, bytewise). | VIN is unique per dealership, so the order is total and stable across requests and restarts. Trade-off: not the most useful order for humans (e.g. newest first); chosen for determinism. |

---

## 4. Out of scope

- Authentication, authorisation, rate limiting, TLS (the service sits behind trusted infrastructure).
- Pagination (documented as a scale-up note; the brief says not required).
- Prometheus metrics and tracing (health endpoint and structured logs only).
- Per-feed history, price history, audit log, or point-in-time queries ("inventory as of date X").
- Out-of-order feed replay/rebuild (D-1 rejects instead).
- Editing or deleting individual vehicles or dealerships through the API.
- VIN decoding, deduplicating vehicles across dealerships, stock-number matching.
- Any frontend.
- Multi-instance deployment (analysed in §8, not built).

---

## 5. Technical details

### 5.1 Architecture

Layers depend inward only. The domain knows nothing about HTTP or SQLite.

```
            ┌────────────────────────────────────────────┐
  HTTP ───► │ http/      Express routes, Zod schemas,    │
            │            error mapping, pino-http        │
            └──────────────────┬─────────────────────────┘
                               │ calls
            ┌──────────────────▼─────────────────────────┐
            │ app/       IngestFeed, InventoryQueries    │  use cases
            └───────┬──────────────────────┬─────────────┘
                    │ uses                 │ depends on (port)
   ┌────────────────▼───────┐   ┌──────────▼──────────────┐
   │ domain/  pure logic    │   │ InventoryRepository     │  interface
   │ vin, reconcile(), days │   └──────────▲──────────────┘
   │ feed hash, types       │              │ implements
   └────────────────────────┘   ┌──────────┴──────────────┐
                                │ infra/sqlite/           │
                                │  repository.ts          │
                                │  driver.ts  ◄─ only file│
                                │  schema.ts   that knows │
                                └─────────────────────────┘ node:sqlite
```

Proportionate-SOLID notes: the repository is a port (dependency inversion) so use cases are testable against a fake; `reconcile()` is a pure function (single responsibility, trivially unit-tested); there is **no** DI container, no abstract factories, no per-entity classes beyond what is needed. Zod refinements in `http/schemas.ts` call the pure rules in `domain/` (VIN length, feed-date guard) instead of re-implementing them.

### 5.2 Repository layout

```
src/
  domain/
    vehicle.ts          # Vehicle, VehicleStatus, Condition, LotStatus types
    vin.ts              # normalizeVin(), VIN length rule
    reconcile.ts        # pure diff: existing + incoming + feedDate -> changes + summary
    days.ts             # daysInInventory(), calendar-date arithmetic in UTC
    feed-hash.ts        # canonical form + sha256
    errors.ts           # StaleFeedError, FeedConflictError, NotFoundError
  app/
    ingest-feed.ts      # orchestrates D-1..D-5 inside one transaction
    queries.ts          # list/find/removed/dealerships
    ports.ts            # InventoryRepository, FeedTransaction, Clock
  infra/sqlite/
    driver.ts           # SqlDatabase interface + node:sqlite implementation (ONLY driver-specific file)
    schema.ts           # DDL + PRAGMAs
    repository.ts        # SqliteInventoryRepository (SQL only, uses SqlDatabase)
  http/
    app.ts              # builds Express app (no listen)
    routes.ts
    schemas.ts          # Zod: feed body, query params, params
    problem.ts          # error -> HTTP mapping
  config.ts             # env parsing (Zod): PORT, DATA_DIR, LOG_LEVEL
  main.ts               # wiring, listen, graceful shutdown
test/
  unit/ integration/ container/
scripts/
  replay-example.sh     # March 15/16 replay with curl
  container-smoke.sh    # exact docker run flags + restart check
examples/
  2026-03-15.json  2026-03-16.json
Dockerfile  .dockerignore  package.json  tsconfig.json
README.md  spec.md  AI_DEVELOPMENT.md
```

### 5.3 Domain model

```ts
type Condition = 'new' | 'used' | 'certified';
type LotStatus = 'on_lot' | 'in_transit';

interface VehicleData {          // what a feed carries (normalized)
  vin: string;                   // trimmed, upper-case
  stockNumber: string;
  condition: Condition;
  lotStatus: LotStatus;
  year: number;
  make: string;
  model: string;
  trim: string | null;           // omitted -> null
  price: number;
  mileage: number;
  stockedOn: string;             // YYYY-MM-DD
}

type StoredVehicle =             // discriminated union, no optional flags
  | (VehicleData & { status: 'active';  removedOn: null })
  | (VehicleData & { status: 'removed'; removedOn: string });
```

**`reconcile(existing, incoming, feedDate)`** is pure and returns:

| Result | Condition |
|---|---|
| `added` | VIN not in `existing` |
| `reactivated` | VIN is `removed` in `existing` and present in `incoming` → replace all fields, `status=active`, `removedOn=null` |
| `updated` | VIN `active` in both, and at least one field differs |
| `unchanged` | VIN `active` in both, no field differs (no write) |
| `removed` | VIN `active` in `existing`, absent from `incoming` → `status=removed`, `removedOn=feedDate` |
| *(untouched)* | VIN already `removed` and still absent: keep original `removedOn` |

**`daysInInventory`** = whole calendar days between `stockedOn` and the reference date, computed via `Date.UTC` on parsed `Y-M-D` (no local-time or DST effects), clamped at `0`. Reference date is `clock.todayUtc()` for active vehicles and `removedOn` for removed vehicles. Check against the brief: Accord `2026-03-10` → `2026-03-16` = **6**, constant afterwards.

**Canonical feed hash** (for D-3): normalize every vehicle (upper-case/trimmed VIN, trimmed strings, `trim ?? null`), sort by VIN, serialise with a fixed key order, SHA-256. `dealershipId` and `feedDate` are part of the key, not the hash. The hash is stored with `hash_version` = `FEED_HASH_VERSION` (currently `1`), written explicitly by the repository; changing the normalization later requires a version bump and migration.

### 5.4 Storage

`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;`
Database at `${DATA_DIR:-/data}/inventory.db`. WAL sidecar files (`-wal`, `-shm`) live next to it, so everything stays inside the writable volume.

```sql
CREATE TABLE feeds (                       -- one row per accepted feedDate; a dealership
  dealership_id TEXT NOT NULL,             -- is "known" iff it has at least one row here
  feed_date     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  hash_version  INTEGER NOT NULL,          -- written from FEED_HASH_VERSION, no default
  PRIMARY KEY (dealership_id, feed_date)
) STRICT, WITHOUT ROWID;

CREATE TABLE vehicles (
  dealership_id TEXT NOT NULL,
  vin           TEXT NOT NULL,
  stock_number  TEXT NOT NULL,
  condition     TEXT NOT NULL CHECK (condition IN ('new','used','certified')),
  lot_status    TEXT NOT NULL CHECK (lot_status IN ('on_lot','in_transit')),
  year          INTEGER NOT NULL,
  make          TEXT NOT NULL COLLATE NOCASE,
  model         TEXT NOT NULL,
  trim          TEXT,
  price         INTEGER NOT NULL CHECK (price > 0),
  mileage       INTEGER NOT NULL CHECK (mileage >= 0),
  stocked_on    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('active','removed')),
  removed_on    TEXT,
  PRIMARY KEY (dealership_id, vin),
  CHECK ((status = 'active' AND removed_on IS NULL)
      OR (status = 'removed' AND removed_on IS NOT NULL))
) STRICT, WITHOUT ROWID;

CREATE INDEX vehicles_by_status ON vehicles (dealership_id, status, vin);
```

**Ingest transaction** (all inside `BEGIN IMMEDIATE … COMMIT`; any thrown error → `ROLLBACK`, which gives FR-9):

1. Read the dealership's latest accepted `feed_date` (`MAX(feed_date)` on `feeds`) and this date's `feeds` row.
2. If a `feeds` row exists for `feedDate`: same hash → return `replayed` (D-3); different hash → `FeedConflictError` (D-2).
3. Else if `feedDate` is earlier than the latest accepted `feed_date` → `StaleFeedError` (D-1).
4. Load the dealership's vehicles (all statuses), run `reconcile`, apply the changes with prepared statements.
5. Insert the `feeds` row (this is what creates the dealership on its first feed), commit.

Validation (Zod, §5.6) always completes **before** the transaction opens, so a malformed feed never takes the write lock.

**Port shape.** The transaction boundary belongs to the port, so the use case never sees SQL. The port is deliberately **synchronous**: an `await` inside `BEGIN IMMEDIATE` would let another request interleave and break D-5.

```ts
interface InventoryRepository {
  inTransaction<T>(fn: (tx: FeedTransaction) => T): T;   // BEGIN IMMEDIATE ... COMMIT; ROLLBACK if fn throws
  // read side (used by queries.ts)
  listDealerships(): DealershipSummary[];
  dealershipExists(id: string): boolean;
  listVehicles(id: string, filter: VehicleFilter): StoredVehicle[];
  findVehicle(id: string, vin: string): StoredVehicle | undefined;
}
interface FeedTransaction {
  latestFeedDate(id: string): string | undefined;
  findFeed(id: string, feedDate: string): { contentHash: string } | undefined;
  loadVehicles(id: string): StoredVehicle[];
  applyChanges(id: string, changes: ReconcileResult): void;
  recordFeed(id: string, feedDate: string, contentHash: string): void;
}
```

`IngestFeed` calls `repo.inTransaction(tx => ...)` and holds the D-1 to D-5 logic. Tests run it against the in-memory SQLite repository, so no hand-written fake is needed.

**Driver seam.** `driver.ts` exports:

```ts
interface SqlDatabase {
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): { changes: number };
  get(sql: string, params?: readonly SqlValue[]): Record<string, unknown> | undefined;
  all(sql: string, params?: readonly SqlValue[]): Record<string, unknown>[];
  transaction<T>(mode: 'immediate' | 'deferred', fn: () => T): T;   // BEGIN/COMMIT/ROLLBACK
  close(): void;
}
```

Rules that keep the swap to one file: positional `?` parameters only (named-parameter handling differs between libraries); rows returned as `unknown` and parsed by hand-written row mappers (no `as` casts); `BEGIN IMMEDIATE` issued as plain SQL (not a library-specific helper). Row mappers in `repository.ts` validate shape, which also catches schema drift.

### 5.5 Graceful shutdown

The container runs Node as PID 1 without `--init`. `main.ts` handles `SIGTERM`/`SIGINT`: `server.close()` plus `closeIdleConnections()` (idle keep-alive sockets would otherwise hold it open), wait for in-flight requests (5 s cap, then `closeAllConnections()`), `db.close()` (checkpoints the WAL), exit 0. Without this, `docker stop` waits 10 s and then `SIGKILL`s.

### 5.6 Validation and error model

Zod schemas are the only runtime boundary (also for env vars and query/path params). The feed schema collects **all** problems (capped at 100, with `truncated: true`) so a provider can fix a bad feed in one round trip.

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Feed rejected: 2 problems found. No inventory was changed.",
    "details": [
      { "path": "vehicles[1].condition", "code": "invalid_value",
        "message": "Expected one of: new, used, certified (received \"cpo\")" },
      { "path": "vehicles[2].vin", "code": "duplicate_vin",
        "message": "Duplicates vehicles[0].vin (2HGFE1F71NH304352)" }
    ],
    "truncated": false
  }
}
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_JSON` | Body is not parseable JSON |
| 400 | `INVALID_REQUEST` | Invalid query or path parameters, including a `{vin}` that is not 17 characters after trimming |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` is not `application/json` |
| 404 | `NOT_FOUND` | Unknown dealership or VIN |
| 409 | `STALE_FEED` | D-1. Body includes `latestFeedDate`. |
| 409 | `FEED_CONFLICT` | D-2. Body includes `feedDate`. |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 10 MB |
| 422 | `VALIDATION_FAILED` | Schema failure (a non-object body is reported at path `""`), future `feedDate` (D-10), or duplicate VIN |
| 500 | `INTERNAL` | Unexpected; body has no internals, the log has the stack and a request id |

---

## 6. API (mapped to requirements)

Base path `/v1`. JSON in, JSON out.

| Method & path | Purpose | Success | Requirements |
|---|---|---|---|
| `POST /v1/feeds` | Ingest a feed (body = the feed document, `dealershipId` inside) | `201` applied · `200` replayed | FR-1, 2, 3, 4, 5, 7, 8, 9, 10, 16; D-1…D-5 |
| `GET /v1/dealerships` | List known dealerships | `200` | FR-15 |
| `GET /v1/dealerships/{id}/vehicles` | Active inventory, filtered | `200` | FR-11, 13 |
| `GET /v1/dealerships/{id}/vehicles?status=removed` | Removed vehicles (same filters allowed) | `200` | FR-14, 13 |
| `GET /v1/dealerships/{id}/vehicles/{vin}` | One vehicle, any status | `200` / `404` | FR-6, 12, 13, 16 |
| `GET /healthz` | Liveness/readiness (opens DB, `SELECT 1`) | `200` `{"status":"ok"}` · `503` | NFR-5 |

**Query parameters** (`/vehicles`): `status=active|removed` (default `active`), `condition`, `lotStatus`, `make` (case-insensitive exact match), `maxPrice` (positive integer, inclusive). Unknown or invalid parameters → `400`. Order: VIN ascending.

**Responses**

`POST /v1/feeds` → `201`. A replay returns `200` with `"status": "replayed"` and a summary whose change counts are all `0` and whose `active` is the dealership's current active count:

```json
{
  "dealershipId": "LHS-1042",
  "feedDate": "2026-03-16",
  "status": "applied",
  "summary": { "added": 1, "updated": 1, "unchanged": 1, "removed": 1, "reactivated": 0, "active": 3 }
}
```

Vehicle representation (list and single; `daysInInventory` shown for a reference date of 2026-03-16):

```json
{
  "vin": "2HGFE1F71NH304352", "stockNumber": "H2401",
  "condition": "used", "lotStatus": "on_lot",
  "year": 2022, "make": "Honda", "model": "Civic", "trim": "EX",
  "price": 17995, "mileage": 41910, "stockedOn": "2026-02-03",
  "status": "active", "removedOn": null, "daysInInventory": 41
}
```

`GET /v1/dealerships` → `{ "dealerships": [ { "dealershipId": "LHS-1042", "latestFeedDate": "2026-03-16", "activeVehicleCount": 3 } ] }` (ordered by `dealershipId`).
List endpoints wrap results as `{ "vehicles": [...], "count": n }`.

### 6.1 Worked example (acceptance scenario)

| Step | Expected |
|---|---|
| POST 03-15 feed | `201`; 3 active |
| POST 03-16 feed | `201`; Civic updated (17995 / 41910), CR-V unchanged, Pilot added, Accord removed; lowercase Civic VIN creates no second vehicle |
| GET Accord by VIN | `200`, `status: removed`, `removedOn: 2026-03-16`, `daysInInventory: 6` (still 6 tomorrow) |
| POST 03-16 feed again | `200 replayed`; inventory identical |
| POST 03-15 feed again | `200 replayed` (known date, same hash; D-3) |
| POST a 03-14 feed, new content | `409 STALE_FEED` |
| POST the 03-15 date again with changed content | `409 FEED_CONFLICT` (that date was already accepted) |
| POST a feed whose `feedDate` is far in the future | `422`, path `feedDate` |
| POST a 03-16 feed, changed price | `409 FEED_CONFLICT` |
| POST feed with `"condition":"cpo"` | `422`, path `vehicles[n].condition`, inventory untouched |
| Another dealership's inventory | unchanged throughout |

---

## 7. Limitations and known risks

| Limitation | Impact | Mitigation / note |
|---|---|---|
| Single instance, single SQLite file | No horizontal scale; a shared volume across instances is unsupported | §8 |
| No history | No price trend, no "as of" queries | Out of scope (D-7) |
| Accepted day is immutable (D-2); strictly forward-only (D-1) | A bad feed cannot be amended; a late feed cannot be inserted | Provider must send a corrected feed with a later date |
| `feedDate` guard depends on the server clock (D-10) | A clock far behind real time would reject legitimate feeds | Keep NTP sync; the +1 day tolerance covers normal skew |
| Empty feed wipes a dealership | Inventory vanishes on a provider bug | `warn` log + summary count; D-4 |
| Whole feed held in memory; 10 MB body cap | Feeds above ~30k vehicles are rejected with `413` | §8 |
| Ingest is synchronous on the event loop | `/healthz` and other requests stall while a very large feed is applied | Generous health-check timeout/retries (§10.1); async ingestion in §8 |
| `node:sqlite` is experimental on some Node versions | Warning at startup; API could change | One-file driver seam; pin exact Node patch version and base-image digest |
| Make filter case-folding is ASCII only | Non-ASCII makes match case-sensitively | Acceptable for current market |
| `daysInInventory` uses server clock | Clock skew shifts the value by a day near midnight UTC | Injected `Clock`; deployments should sync time |
| SQLite WAL on a Docker named volume | Fine on local volumes; unsafe on network filesystems | Documented in README |

---

## 8. Scaling notes (documented, not built)

| Dimension | Today | What changes |
|---|---|---|
| **Thousands of dealerships** | One table set keyed by `dealership_id`; every query hits the `(dealership_id, status, vin)` index. The dealership list is one grouped query. | Fine on SQLite up to large counts; add pagination (`limit` + keyset cursor on `vin`) to the list endpoints and to `/v1/dealerships`; maintain an `active_count` column instead of counting. |
| **Feeds of tens of thousands of vehicles** | Whole body parsed in memory (10 MB cap), validated, then reconciled in one transaction. | Streaming JSON parse and chunked validation; reconcile with SQL (`INSERT … ON CONFLICT`, anti-join for removals) using a temp table instead of loading all vehicles into memory; raise body limit or accept gzip. Ingest takes the write lock for the whole feed, so very large feeds would block other writers → move to async ingestion (`202 Accepted` + job id). |
| **Multiple instances** | Unsupported (single SQLite file). | Move to Postgres. Replace `BEGIN IMMEDIATE` with a per-dealership lock (`SELECT … FOR UPDATE` on the `dealerships` row, or advisory lock) so concurrent feeds for one dealership serialise while different dealerships proceed in parallel. Pure `reconcile()` is unchanged. The `InventoryRepository` port and its callers become async, and the lock replaces the single-threaded guarantee that D-5 relies on today. `Clock` and idempotency by content hash already work across instances. |

---

## 9. Testing plan

Runner: `node:test` with `tsx`; integration tests drive the real Express app over HTTP on an ephemeral port using `fetch`. Unit/integration use `:memory:` SQLite; durability tests use a temp file. The injected `Clock` pins "today" so `daysInInventory` is deterministic. Type-check (`tsc --noEmit`) and `npm test` must pass before each commit.

### 9.1 Unit tests (domain, no I/O)

| Area | Cases | Covers |
|---|---|---|
| `normalizeVin` | whitespace, lower-case, mixed | FR-16 |
| `normalizeVin` length rule | 16 and 18 characters rejected; 17 after trimming accepted; inner characters unrestricted | D-9 |
| `daysInInventory` | Accord 03-10 → 03-16 = 6; same day = 0; month/year/leap-year boundaries; `stockedOn` in future → 0 | FR-13, A-5 |
| Feed-date guard | today and today+1 accepted; today+2 rejected (injected clock) | D-10 |
| `reconcile` | added / updated / unchanged / removed / reactivated; already-removed stays removed with its original `removedOn`; absent across several feeds keeps the first `removedOn`; removed → reactivated → removed again sets a new `removedOn`; empty incoming removes all; `stockedOn` change on an active vehicle counts as updated | FR-3…7, D-4 |
| `feed-hash` | order-independent; VIN case/whitespace-independent; omitted vs `null` trim equal; any field change alters hash | D-3 |

### 9.2 Repository tests (SQLite)

| Case | Covers |
|---|---|
| Round-trip all fields incl. `trim = null` | FR-1 |
| Transaction rolls back fully if a statement fails midway (inject a failing write; inventory and `feeds` unchanged) | FR-9 |
| CHECK constraints reject `status/removed_on` mismatch | data integrity |
| Reopen the same file: data intact | NFR-2 |
| Two connections on one temp file: while one holds `BEGIN IMMEDIATE`, the other waits and then proceeds (or fails with `SQLITE_BUSY` after `busy_timeout`) | D-5 |
| Row mapper throws on a malformed row | no unsafe casts |

### 9.3 API integration tests

| Group | Cases | Covers |
|---|---|---|
| Example progression | Full 03-15 → 03-16 scenario from §6.1, asserting every bullet | FR-2…8, 12, 13 |
| Idempotency | Same feed twice: `201` then `200 replayed`; list identical; repeating an older accepted date → `200` | FR-8, D-3 |
| Stale / conflict | Earlier never-accepted date, new content → `409 STALE_FEED`; same date changed → `409 FEED_CONFLICT`; earlier *already-accepted* date with changed content → `409 FEED_CONFLICT`; none mutate state | D-1, D-2 |
| Reactivation | Vehicle removed then reappears with new `stockedOn`: active, `removedOn: null`, days from new `stockedOn` | FR-7 |
| Empty feed | Accepted; all removed; dealership still listed with 0 active | D-4, FR-15 |
| Atomicity | Feed with 1 invalid vehicle among valid ones: `422`, inventory byte-identical to before (including a *first* feed: dealership not created) | FR-9, FR-2 |
| Error quality | `cpo` condition, bad date (`2026-02-30`), VIN of 16 or 18 chars, duplicate VIN after case-folding, negative mileage, float price, missing field, `trim: ""`, top-level array / `null` / string body, wrong `Content-Type` (`415`), future `feedDate`, several errors reported together with correct `path`; an extra unknown key is ignored and the feed accepted | FR-10, A-2, D-10 |
| Multi-tenancy | Feed for dealership B leaves A untouched; same VIN in both dealerships coexists | FR-2 |
| Filters | Each of condition / lotStatus / make (case-insensitive) / maxPrice (inclusive) alone and combined; `status=removed`; invalid values → `400`; ordering is VIN asc | FR-11, 14, A-12 |
| VIN lookup | Lower-case + padded VIN finds the vehicle; removed vehicle found; unknown → `404`; unknown dealership → `404` | FR-6, 12, 16 |
| Dealership list | Latest `feedDate` and active count correct after several feeds | FR-15 |
| Concurrency | `Promise.all` of two same-date, different-content feeds for one dealership → exactly one `201` and one `409`; two different-date feeds fired together → each response is `201` or `409`, and the final state always equals the later-dated feed (never a mix); the real lock is exercised by the two-connection test in §9.2 | D-5 |
| Operational | Malformed JSON → `400`; body > limit → `413`; `/healthz` → `200`, and `503` when the DB handle is closed; `GET …/vehicles/{vin}` with a non-17-character VIN → `400` | NFR-5 |
| Days freezing | Advance injected clock 30 days: active `daysInInventory` grows, removed stays 6 | FR-13 |
| Lifecycle | Remove → reactivate → remove again: `removedOn` is the second absence; absent across three feeds keeps the first `removedOn`; a gap between feed dates (03-15 → 03-20) removes by feed, not by elapsed days | FR-5, 7 |

### 9.4 Container smoke test (`scripts/container-smoke.sh`)

Run with the **exact** evaluator command (`--read-only --tmpfs /tmp --cap-drop ALL --memory 512m --cpus 1 -v inventory-data:/data -p 8080:8080`), then:

1. Wait for `/healthz` (and check the Docker `HEALTHCHECK` status becomes `healthy`).
2. Replay the March 15/16 example (`scripts/replay-example.sh`) and compare to the expected output, ignoring `daysInInventory` on *active* vehicles (it depends on today's date) but asserting the removed Accord is exactly `6`.
3. `docker stop` (assert exit code 0 well inside Docker's 10 s kill timeout, which proves SIGTERM handling) and `docker start` with the same volume; assert inventory is unchanged.
4. Confirm `docker exec id -u` is non-zero, and that writes outside `/data` and `/tmp` fail.
5. Run once with `--network none` to prove no outbound dependency.
6. Build with `--platform linux/amd64` and check `docker image inspect` → `Architecture: amd64`.


---

## 10. Container and operations

### 10.1 Dockerfile outline

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build                     # tsc -> dist/

FROM node:24-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 \
    NODE_OPTIONS=--max-old-space-size=384
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# /data must exist in the image and be owned by the runtime user so a fresh
# named volume inherits that ownership
RUN mkdir -p /data && chown 10001:10001 /data
USER 10001:10001
EXPOSE 8080
VOLUME /data
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=5 \
  CMD ["node","-e","fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","dist/main.js"]
```

Notes: no `curl` in slim images, so the health probe uses Node's built-in `fetch`. `--max-old-space-size=384` leaves headroom under the 512 MB cap for buffers and the SQLite page cache. The base image should be pinned by digest when finalising. Build with `docker buildx build --platform linux/amd64 …` (the platform is not hard-coded in `FROM`). Ingest runs synchronously on the event loop, so `/healthz` can stall during a very large feed; the generous timeout and retries avoid flapping to `unhealthy`. Named-volume ownership copy-up is Docker behaviour; a pre-existing root-owned volume needs a `chown` (README note). If the driver is swapped to `better-sqlite3`, the build stage needs its prebuilt binary (glibc, amd64) or build tools; the runtime stage stays the same.

### 10.2 Runtime constraints checklist

| Constraint | How it is met |
|---|---|
| Read-only root FS | App writes only to `/data` (DB + WAL) and, if ever needed, `/tmp`. No other writes (no log files, Pino writes to stdout). |
| `--cap-drop ALL` | Non-root user, port 8080 (> 1024), no privileged operations. |
| Non-root | `USER 10001`; numeric so it works with `runAsNonRoot` policies. |
| Empty named volume at `/data` | `/data` created and chowned in the image; volume inherits ownership on first use. |
| 512 MB / 1 CPU | Heap capped; body limit 10 MB; single-threaded service. |
| No credentials / internet | None needed. |
| Health | `GET /healthz`; Docker `HEALTHCHECK` uses it. Documented in README. |
| Restart persistence | WAL + `synchronous=FULL`, clean shutdown closes the DB (§5.5). |

### 10.3 Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `DATA_DIR` | `/data` | Directory for `inventory.db` |
| `LOG_LEVEL` | `info` | Pino level |

Parsed and validated with Zod at start-up; invalid config fails fast with a clear message.

---

## 11. Implementation milestones

Target about 2 to 2.5 hours (the estimate below is ~145 min; hard cap 4 h). Each milestone runs the test-first loop (see `.claude/skills/tdd-implementation-loop`): write tests, write the code, then build and test until green. **Testing is the last step of every milestone**: a milestone is not done until `npm run typecheck` and `npm test` pass. Each milestone is its own commit (history is not squashed).

### M0: Scaffold (~10 min)

- **Covers:** NFR-1 (no external services, dependencies chosen accordingly), NFR-6 (test runner in place).

- **Build:** `package.json` (ESM, Node ≥ 22.13, scripts `build`, `typecheck`, `test`, `start`), strict `tsconfig` (`NodeNext`, no `any`), `.gitignore`, `.dockerignore`, dependencies, and `config.ts` with Zod env parsing.
- **Testing:** *Unit.* Config defaults, and a bad `PORT` failing with a readable error. Ends with the build and the test runner both green.

### M1: Domain logic (~25 min)

- **Covers:** FR-3, FR-4, FR-5, FR-7 (reconcile outcomes), FR-8 (canonical hash), FR-13 (days in inventory), FR-16 (VIN normalization); D-3, D-4, D-9, D-10; A-5, A-6.

- **Build:** VIN normalization and the 17-character rule, UTC day arithmetic, the feed-date guard, the canonical feed hash, and `reconcile()` (added, updated, unchanged, removed, reactivated), plus types and domain errors.
- **Testing:** *Unit, pure functions, no I/O* (§9.1). Covers every `reconcile` outcome, the Accord = 6 days example, and the date boundaries. Ends when the brief's March 15→16 example reproduces at the function level.

### M2: Storage (~20 min)

- **Covers:** FR-2 (dealership known via first accepted feed), FR-6 (removed vehicles persisted), FR-9 (rollback = all-or-nothing), FR-15 (dealership summary data); NFR-2 (survives reopen); D-5 (write lock), D-6, D-7.

- **Build:** the SQLite driver file, schema, and repository with `inTransaction`.
- **Testing:** *Integration against real SQLite* (§9.2). Covers a round-trip of every field, rollback leaving no partial writes, and data surviving a reopen. Ends with the two-connection lock check.

### M3: Use cases and HTTP (~35 min)

- **Covers:** FR-1 to FR-16 end to end through the API (the table below shows which are first delivered in M1 and M2); NFR-5 (`/healthz`), NFR-6; D-1 to D-5, A-2, A-12.

- **Build:** `IngestFeed`, the queries, Zod schemas, Express routes, error mapping, Pino logging, and graceful shutdown.
- **Testing:** *API integration over real HTTP* (§9.3). Covers the full March 15/16 scenario, idempotent replay, the 409 stale and conflict cases, atomic rejection, filters, VIN lookup, and concurrent feeds. Ends with the whole suite green.

### M4: Container and delivery (~35 min)

- **Covers:** NFR-1 (no network), NFR-2 (restart persistence), NFR-3 (amd64, port 8080, default command), NFR-4 (non-root, read-only, caps dropped, 512 MB), NFR-5 (Docker `HEALTHCHECK`).

- **Build:** the `Dockerfile`, `HEALTHCHECK`, and the image delivery: a `docker save | gzip` archive with load instructions (default), optionally a public GHCR package with the immutable digest recorded.
- **Testing:** *Smoke test* (§9.4). Runs `container-smoke.sh` with the exact evaluator flags and replays the example, then stops and restarts the container on the same volume. Also checks non-root, a read-only filesystem, and `--network none`. Ends with the script passing on a clean volume.

### M5: Docs and deliverables (~20 min)

- **Covers:** NFR-7 (README and docs), NFR-8 (replay script), NFR-9 (`AI_DEVELOPMENT.md`).

- **Build:** `README.md`, `scripts/replay-example.sh`, the example JSON files, and `AI_DEVELOPMENT.md`.
- **Testing:** *Manual walkthrough.* Follow the README from a clean checkout (build, run, replay) and confirm each documented command works. Ends when the final full test run and smoke run are both green.

### Requirement traceability

Every requirement from §2 lands in at least one milestone. "Logic" is the milestone where the rule is first implemented and unit-tested; "Delivered" is where it is exposed and verified end to end.

| Requirement | Logic | Delivered |
|---|---|---|
| FR-1 Ingest feed | M1 (validation rules) | M3 |
| FR-2 Dealership known on first feed | M2 | M3 |
| FR-3 New VIN becomes active | M1 | M3 |
| FR-4 Active VIN updated | M1 | M3 |
| FR-5 Missing VIN becomes removed | M1 | M3 |
| FR-6 Removed stays retrievable | M2 | M3 |
| FR-7 Removed VIN reactivated | M1 | M3 |
| FR-8 Replay is idempotent | M1 (hash) | M3 |
| FR-9 All-or-nothing | M2 (rollback) | M3 |
| FR-10 Errors say what and where | M3 | M3 |
| FR-11 Active inventory + filters + order | M3 | M3 |
| FR-12 Find by VIN | M3 | M3 |
| FR-13 Days in inventory | M1 | M3 |
| FR-14 List removed vehicles | M3 | M3 |
| FR-15 List dealerships | M2 | M3 |
| FR-16 VIN case/whitespace-insensitive | M1 | M3 |
| NFR-1 No external services | M0 | M4 |
| NFR-2 Persistence across restart | M2 | M4 |
| NFR-3 amd64 image, port 8080 | M4 | M4 |
| NFR-4 Non-root, read-only, caps dropped | M4 | M4 |
| NFR-5 Health check | M3 | M4 |
| NFR-6 Automated tests | M0 | M1 to M3 |
| NFR-7 Documentation | M5 | M5 |
| NFR-8 Replay script | M5 | M5 |
| NFR-9 `AI_DEVELOPMENT.md` | M5 | M5 |

**Total: ~145 min.**

If time runs out, cut in this order: unit-test breadth, then docs polish, then extra filter tests. Never cut: atomicity, idempotency, reactivation, and the container smoke test. Anything cut is listed under "incomplete work" in the README.

---

## 12. Deliverables checklist

- [ ] Repository public, or shared with the `C-4Engineering` GitHub org
- [ ] `Dockerfile` + prebuilt `linux/amd64` image (registry digest or archive with load instructions)
- [ ] `README.md`: build/run/test, API, architecture and decisions (D-1…D-10), scale notes, assumptions, limitations
- [ ] `scripts/replay-example.sh` (and `examples/*.json`) replaying March 15/16
- [ ] Automated tests passing
- [ ] `AI_DEVELOPMENT.md`
- [ ] Email to the three addressees in the brief

## 13. Resolved and remaining decisions

Resolved with the author: storage (`node:sqlite` behind a one-file driver seam), Express + Zod, D-1 and D-2 (reject), empty feed accepted, serialisation via `BEGIN IMMEDIATE`, current-state data model, Pino logging. After the independent review: VIN is a 17-character length check only (D-9), and a future-date guard was added (D-10).

Defaults chosen without asking; say the word to change any:

- A-2 ignore unknown keys (changed from strict after review)
- A-12 VIN-ascending order (vs. e.g. `stockedOn` descending)
- A-11 Node 24 LTS base image (vs. 22)
- Response codes `201` (applied) / `200` (replayed)
- Image delivery: compressed archive (default) vs. public GHCR package
