import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const bundled = resolve(__dirname, 'hasura/metadata.json');
const script = resolve(__dirname, 'export-hasura-metadata.sh');

describe('bundled Hasura metadata baseline', () => {
  it('exists and is valid version-3 metadata with tracked tables', () => {
    expect(existsSync(bundled)).toBe(true);
    const meta = JSON.parse(readFileSync(bundled, 'utf8'));
    expect(meta.version).toBe(3);
    expect(Array.isArray(meta.sources)).toBe(true);
    expect(meta.sources[0].tables.length).toBeGreaterThan(50);
  });

  it('carries no obvious secret values (only column names / env refs)', () => {
    const raw = readFileSync(bundled, 'utf8');
    // admin secret / bearer / long hex tokens must not appear
    expect(raw).not.toMatch(/x-hasura-admin-secret"\s*:\s*"[^"]+"/i);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  it('export helper exists and is referenced for refresh', () => {
    expect(existsSync(script)).toBe(true);
  });
});
