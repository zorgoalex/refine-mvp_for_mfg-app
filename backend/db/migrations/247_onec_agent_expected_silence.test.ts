import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXPECTED_SILENCE_PATTERN } from '../../src/modules/onec-agent/domain/onec-expected-silence';

const sql = readFileSync(resolve(__dirname, '247_onec_agent_expected_silence.sql'), 'utf8');

describe('migration 247: expected daily silence of a 1C agent', () => {
  it('is one transaction with bounded lock waits and schema-neutral names', () => {
    expect(sql).toMatch(/^BEGIN;\s*$/m);
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '60s';");
    // 193–200 are unqualified: the module's test harnesses apply them in their own schema.
    expect(sql).not.toContain('public.');
    expect(sql).not.toMatch(/CONCURRENTLY/i);
  });

  it('adds a nullable column with the same format the backend validates', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS expected_silence_utc TEXT NULL');
    const dbPattern = sql.match(/expected_silence_utc ~ '([^']+)'/)?.[1];
    expect(dbPattern).toBe('^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$');
    for (const value of ['23:45-00:25', '00:00-23:59', '24:00-00:10', '2345-0025', '1:00-2:00', '']) {
      expect(new RegExp(dbPattern!).test(value), value).toBe(EXPECTED_SILENCE_PATTERN.test(value));
    }
    expect(sql).toContain("conname = 'chk_onec_agents_expected_silence_utc'");
  });
});
