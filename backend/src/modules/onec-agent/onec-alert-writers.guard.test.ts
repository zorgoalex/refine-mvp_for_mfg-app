import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Every change of onec_alerts must write its episode in the same statement (plan 2026-10-19 §2.2): otherwise the
 * notification dispatcher misses a transition. So writes to onec_alerts live only in PgOnecRepository, and each of
 * them is a statement that also touches onec_alert_episodes — except the retention cleanup of resolved alerts.
 */
const SRC = resolve(__dirname, '../..');
const REPOSITORY = 'modules/onec-agent/adapters/pg-onec-repository.ts';
const WRITE = /\b(?:UPDATE\s+onec_alerts|INSERT\s+INTO\s+onec_alerts|DELETE\s+FROM\s+onec_alerts)\b/i;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$|\.integration\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Template literals of a file (SQL statements are written as backtick strings in this code base). */
function templates(text: string): string[] {
  return [...text.matchAll(/`[^`]*`/g)].map((m) => m[0]);
}

describe('onec_alerts writers', () => {
  it('only PgOnecRepository writes onec_alerts', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => relative(SRC, file) !== REPOSITORY)
      .filter((file) => WRITE.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  it('each write of onec_alerts in the repository also writes the episode, except the retention cleanup', () => {
    const writes = templates(readFileSync(join(SRC, REPOSITORY), 'utf8')).filter((sql) => WRITE.test(sql));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    const withoutEpisode = writes.filter((sql) => !/onec_alert_episodes/.test(sql));
    expect(withoutEpisode).toHaveLength(1);
    expect(withoutEpisode[0]).toMatch(/DELETE FROM onec_alerts WHERE state = 'resolved'/);
  });
});
