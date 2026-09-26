import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** §5.4d: commands must decide on the EFFECTIVE column (loadMdfEffectivePlacement), never the stored
 * `mdf_published_sources.column_key`. Only these modules may touch the stored column. */
const ALLOWED = new Set([
  'mdf-board/adapters/mdf-publication.ts',          // writer
  'mdf-board/adapters/mdf-effective-placement.ts',  // effective loader (fallback value)
  'mdf-board/adapters/mdf-published-snapshot.ts',   // reader: overwritten by the effective column
  'mdf-board/adapters/mdf-correction-snapshot.ts',  // overwritten by the effective column
  'mdf-board/application/mdf-accepted-job.ts',      // job-time history/prior column of unverified cards
  'status-automation/adapters/pg-mdf-board-event-repository.ts', // legacy derived alias, not the published column
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith('.ts') && !/\.test\.ts$|\.integration\.ts$/.test(path) ? [path] : [];
  });
}

describe('stored MDF column is not a command decision input', () => {
  it('reads column_key only in the allowed modules', () => {
    const root = join(__dirname, '..', '..');
    const offenders = files(root).map(path => path.slice(root.length + 1))
      .filter(path => readFileSync(join(root, path), 'utf8').includes('column_key') && !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });
});
