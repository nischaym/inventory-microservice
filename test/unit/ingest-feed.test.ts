import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { IngestFeed, type Feed, type IngestLogger } from '../../src/app/ingest-feed.js';
import { FeedConflictError, StaleFeedError } from '../../src/domain/errors.js';
import { FEED_HASH_VERSION, FeedHashVersionMismatchError } from '../../src/domain/feed-hash.js';
import type { SqlDatabase } from '../../src/infra/sqlite/driver.js';
import type { SqliteInventoryRepository } from '../../src/infra/sqlite/repository.js';
import { accord, asActive, asRemoved, civicMarch15, civicMarch16, crv, pilot } from '../fixtures/brief-example.js';
import { openRepository } from '../helpers/sqlite-repository.js';

const DEALERSHIP = 'LHS-1042';

const march15: Feed = { dealershipId: DEALERSHIP, feedDate: '2026-03-15', vehicles: [civicMarch15, crv, accord] };
const march16: Feed = {
  dealershipId: DEALERSHIP,
  feedDate: '2026-03-16',
  vehicles: [{ ...civicMarch16, vin: '2hgfe1f71nh304352' }, crv, pilot],
};

class RecordingLogger implements IngestLogger {
  readonly warnings: Array<{ details: Record<string, unknown>; message: string }> = [];

  warn(details: Record<string, unknown>, message: string): void {
    this.warnings.push({ details, message });
  }
}

describe('IngestFeed', () => {
  let db: SqlDatabase;
  let repository: SqliteInventoryRepository;
  let logger: RecordingLogger;
  let ingestFeed: IngestFeed;

  beforeEach(() => {
    ({ db, repository } = openRepository());
    logger = new RecordingLogger();
    ingestFeed = new IngestFeed(repository, logger);
  });

  afterEach(() => {
    db.close();
  });

  function inventory(dealershipId = DEALERSHIP) {
    return repository.inTransaction((transaction) => ({
      vehicles: transaction.loadVehicles(dealershipId),
      latestFeedDate: transaction.latestFeedDate(dealershipId),
    }));
  }

  test('FR-2: the first feed is applied and makes the dealership known', () => {
    assert.equal(repository.dealershipExists(DEALERSHIP), false);

    assert.deepEqual(ingestFeed.execute(march15), {
      dealershipId: DEALERSHIP,
      feedDate: '2026-03-15',
      status: 'applied',
      summary: { added: 3, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active: 3 },
    });
    assert.equal(repository.dealershipExists(DEALERSHIP), true);
  });

  test('brief example: March 16 updates the Civic, keeps the CR-V, adds the Pilot, removes the Accord', () => {
    ingestFeed.execute(march15);

    const outcome = ingestFeed.execute(march16);

    assert.equal(outcome.status, 'applied');
    assert.deepEqual(outcome.summary, { added: 1, updated: 1, unchanged: 1, removed: 1, reactivated: 0, active: 3 });
    assert.deepEqual(inventory().vehicles, [
      asRemoved(accord, '2026-03-16'),
      asActive(civicMarch16),
      asActive(pilot),
      asActive(crv),
    ]);
  });

  describe('D-3 replay', () => {
    test('the same feed again is replayed: zero changes, current active count, inventory untouched', () => {
      ingestFeed.execute(march15);
      ingestFeed.execute(march16);
      const before = inventory();

      assert.deepEqual(ingestFeed.execute(march16), {
        dealershipId: DEALERSHIP,
        feedDate: '2026-03-16',
        status: 'replayed',
        summary: { added: 0, updated: 0, unchanged: 0, removed: 0, reactivated: 0, active: 3 },
      });
      assert.deepEqual(inventory(), before);
    });

    test('replaying an older accepted feed does not roll inventory back', () => {
      ingestFeed.execute(march15);
      ingestFeed.execute(march16);
      const before = inventory();

      assert.equal(ingestFeed.execute(march15).status, 'replayed');
      assert.deepEqual(inventory(), before);
    });

    test('a replay with reordered vehicles and differently cased VINs is still a replay', () => {
      ingestFeed.execute(march15);
      const reordered: Feed = {
        ...march15,
        vehicles: [accord, { ...crv, vin: ` ${crv.vin.toLowerCase()} ` }, civicMarch15],
      };

      assert.equal(ingestFeed.execute(reordered).status, 'replayed');
    });
  });

  describe('D-2 conflict', () => {
    test('the latest date with different content is rejected and changes nothing', () => {
      ingestFeed.execute(march15);
      ingestFeed.execute(march16);
      const before = inventory();
      const changedPrice: Feed = { ...march16, vehicles: [{ ...civicMarch16, price: 16995 }, crv, pilot] };

      assert.throws(
        () => ingestFeed.execute(changedPrice),
        (error) => error instanceof FeedConflictError && error.dealershipId === DEALERSHIP && error.feedDate === '2026-03-16',
      );
      assert.deepEqual(inventory(), before);
    });

    test('an earlier, already-accepted date with different content is a conflict, not stale', () => {
      ingestFeed.execute(march15);
      ingestFeed.execute(march16);
      const before = inventory();

      assert.throws(() => ingestFeed.execute({ ...march15, vehicles: [crv] }), FeedConflictError);
      assert.deepEqual(inventory(), before);
    });
  });

  describe('D-1 stale', () => {
    test('an earlier, never-accepted date is rejected with the latest feed date and changes nothing', () => {
      ingestFeed.execute(march15);
      ingestFeed.execute(march16);
      const before = inventory();

      assert.throws(
        () => ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-14', vehicles: [pilot] }),
        (error) => error instanceof StaleFeedError && error.latestFeedDate === '2026-03-16' && error.feedDate === '2026-03-14',
      );
      assert.deepEqual(inventory(), before);
    });

    test('a later date after a gap is applied; removal is by feed, not elapsed days', () => {
      ingestFeed.execute(march15);

      const outcome = ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-20', vehicles: [crv] });

      assert.equal(outcome.status, 'applied');
      assert.deepEqual(inventory().vehicles, [
        asRemoved(accord, '2026-03-20'),
        asRemoved(civicMarch15, '2026-03-20'),
        asActive(crv),
      ]);
    });
  });

  describe('D-4 empty feed', () => {
    test('is applied, removes every active vehicle and logs a warning', () => {
      ingestFeed.execute(march15);

      const outcome = ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-16', vehicles: [] });

      assert.deepEqual(outcome.summary, { added: 0, updated: 0, unchanged: 0, removed: 3, reactivated: 0, active: 0 });
      assert.equal(logger.warnings.length, 1);
      assert.deepEqual(logger.warnings[0]?.details, { dealershipId: DEALERSHIP, feedDate: '2026-03-16', removed: 3 });
      assert.equal(repository.dealershipExists(DEALERSHIP), true);
    });

    test('non-empty feeds log no warning', () => {
      ingestFeed.execute(march15);
      ingestFeed.execute(march16);
      assert.deepEqual(logger.warnings, []);
    });
  });

  describe('stored hash made by a different FEED_HASH_VERSION', () => {
    const otherHashVersion = FEED_HASH_VERSION + 1;

    function markFeedHashedWithOtherVersion(feedDate: string): void {
      db.run('UPDATE feeds SET hash_version = ? WHERE dealership_id = ? AND feed_date = ?', [otherHashVersion, DEALERSHIP, feedDate]);
    }

    test('the same feed is not reported as replayed; it fails with a mismatch and changes nothing', () => {
      ingestFeed.execute(march15);
      markFeedHashedWithOtherVersion('2026-03-15');
      const before = inventory();

      assert.throws(
        () => ingestFeed.execute(march15),
        (error: unknown) =>
          error instanceof FeedHashVersionMismatchError &&
          error.dealershipId === DEALERSHIP &&
          error.feedDate === '2026-03-15' &&
          error.storedHashVersion === otherHashVersion &&
          error.currentHashVersion === FEED_HASH_VERSION,
      );
      assert.deepEqual(inventory(), before);
    });

    test('different content is a mismatch, not a misleading FEED_CONFLICT', () => {
      ingestFeed.execute(march15);
      markFeedHashedWithOtherVersion('2026-03-15');

      assert.throws(
        () => ingestFeed.execute({ ...march15, vehicles: [crv] }),
        (error: unknown) => error instanceof FeedHashVersionMismatchError && !(error instanceof FeedConflictError),
      );
    });

    test('a new date is still applied: only comparisons with the old hash are refused', () => {
      ingestFeed.execute(march15);
      markFeedHashedWithOtherVersion('2026-03-15');

      assert.equal(ingestFeed.execute(march16).status, 'applied');
    });
  });

  test('FR-7: a removed vehicle that reappears is reactivated with the new feed data', () => {
    ingestFeed.execute(march15);
    ingestFeed.execute(march16);
    const relisted = { ...accord, price: 29990, stockedOn: '2026-03-18' };

    const outcome = ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-18', vehicles: [relisted] });

    assert.equal(outcome.summary.reactivated, 1);
    assert.deepEqual(inventory().vehicles[0], asActive(relisted));
  });

  test('FR-2: a feed only affects the dealership it names', () => {
    ingestFeed.execute({ dealershipId: 'OTHER-1', feedDate: '2026-03-01', vehicles: [crv, accord] });
    const otherBefore = inventory('OTHER-1');

    ingestFeed.execute(march15);
    ingestFeed.execute({ dealershipId: DEALERSHIP, feedDate: '2026-03-16', vehicles: [] });

    assert.deepEqual(inventory('OTHER-1'), otherBefore);
  });
});
