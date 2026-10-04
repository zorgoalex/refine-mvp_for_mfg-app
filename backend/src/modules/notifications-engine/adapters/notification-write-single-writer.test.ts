import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// План 2026-10-03 §2.1: строки `notifications` пишет только единый адаптер записи (решение о балуне — в одном месте).
const root = join(__dirname, '..', '..', '..');
const ALLOWED = new Set(['modules/notifications-engine/adapters/pg-notification-write.ts']);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.(test|spec|integration)\.ts$|\.integration\.test\.ts$|\.integration\.ts$/.test(name) ? [path] : [];
  });
}

describe('single notification writer', () => {
  it('no production code inserts into notifications except PgNotificationWriteAdapter', () => {
    const offenders = sources(root)
      .map((path) => relative(root, path).split(sep).join('/'))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) => /INSERT\s+INTO\s+(public\.)?notifications\b(?!_)/i.test(readFileSync(join(root, path), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
