import { describe, expect, it } from 'vitest';
import { PERSONAL_DATA_TTL_MS } from '../onec-agent/domain/onec-etl';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseKeyHash, caseKeyMask } from './duplicate-keys';
import { DUPLICATE_RULES } from './duplicate-rules';

describe('keys and masks of duplicate cases', () => {
  it('the key is an HMAC: the same rule and key give one hash, another secret or rule another', () => {
    const a = caseKeyHash('s'.repeat(32), 'client.phone', '7015554433');
    expect(caseKeyHash('s'.repeat(32), 'client.phone', '7015554433').equals(a)).toBe(true);
    expect(caseKeyHash('t'.repeat(32), 'client.phone', '7015554433').equals(a)).toBe(false);
    expect(caseKeyHash('s'.repeat(32), 'supplier.phone', '7015554433').equals(a)).toBe(false);
  });

  it('masks keep two digits of a phone or an IIN and hide the name of a person', () => {
    expect(caseKeyMask('phone', '7015554433', false)).toBe('+7 *** *** ** 33');
    expect(caseKeyMask('bin', '880101300123', true)).toBe('ИИН/БИН ••••••••••23');
    expect(caseKeyMask('name', 'иванов иван', true)).toBe('ФИО (скрыто)');
    expect(caseKeyMask('name', 'альфа', false)).toBe('альфа');
    expect(caseKeyMask('composite', 'мдф 16:3', false)).toBe('мдф 16');
    expect(caseKeyMask('name', 'x'.repeat(300), false)).toHaveLength(120);
  });

  it('rule codes are unique and fit the column check', () => {
    const codes = DUPLICATE_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z_]+\.[a-z0-9_]+$/);
  });

  it('the personal data term in migration 267 equals the one of the 1C module', () => {
    const sql = readFileSync(resolve(__dirname, '../../../db/migrations/267_integration_duplicates.sql'), 'utf8');
    const days = Number(/now\(\) - interval '(\d+) days'/.exec(sql)?.[1]);
    expect(days * 24 * 60 * 60_000).toBe(PERSONAL_DATA_TTL_MS);
  });
});
