import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Creates an empty temp directory; call the returned cleanup in `after`/`afterEach`. */
export function createTempDirectory(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'inventory-test-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
