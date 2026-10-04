import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_SCREEN_CODES,
  CLIENT_SCREEN_DEFAULT_VISIBLE_CODES,
  CLIENT_SCREEN_GROUPS,
  isClientScreenCodeVisible,
  normalizeClientScreenCodes,
} from './clientScreenRegistry';

describe('client screen registry', () => {
  it('lists every code exactly once across groups (tab code or field)', () => {
    const seen: string[] = [];
    for (const group of CLIENT_SCREEN_GROUPS) {
      if (group.tabCode) seen.push(group.tabCode);
      for (const field of group.fields) seen.push(field.code);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...CLIENT_SCREEN_CODES].sort());
  });

  it('has the summary group first without a tab code, then one group per tab', () => {
    expect(CLIENT_SCREEN_GROUPS.map((g) => g.key)).toEqual(['summary', 'basic', 'details', 'dates', 'finance', 'services']);
    expect(CLIENT_SCREEN_GROUPS[0].tabCode).toBeNull();
    for (const group of CLIENT_SCREEN_GROUPS.slice(1)) {
      expect(group.tabCode).toBe(`tab.${group.key}`);
      for (const field of group.fields) expect(field.code.startsWith(`${group.key}.`)).toBe(true);
    }
  });

  it('has non-empty labels', () => {
    for (const group of CLIENT_SCREEN_GROUPS) {
      expect(group.label.trim()).not.toBe('');
      for (const field of group.fields) expect(field.label.trim()).not.toBe('');
    }
  });

  it('keeps defaults within the registry', () => {
    const all = new Set<string>(CLIENT_SCREEN_CODES);
    for (const code of CLIENT_SCREEN_DEFAULT_VISIBLE_CODES) expect(all.has(code)).toBe(true);
    expect(normalizeClientScreenCodes(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES)).toEqual([...CLIENT_SCREEN_DEFAULT_VISIBLE_CODES]);
  });

  it('normalizes: known only, no repeats, registry order', () => {
    expect(normalizeClientScreenCodes(['tab.basic', 'bogus', 'summary.number', 'tab.basic'])).toEqual([
      'summary.number',
      'tab.basic',
    ]);
    expect(normalizeClientScreenCodes([])).toEqual([]);
  });

  it('computes visibility of tabs, summary fields and tab fields', () => {
    const set = new Set(['summary.number', 'tab.basic', 'basic.client', 'details.n', 'finance.paid']);
    expect(isClientScreenCodeVisible('summary.number', set)).toBe(true);
    expect(isClientScreenCodeVisible('summary.client', set)).toBe(false);
    expect(isClientScreenCodeVisible('tab.basic', set)).toBe(true);
    expect(isClientScreenCodeVisible('tab.dates', set)).toBe(false);
    expect(isClientScreenCodeVisible('basic.client', set)).toBe(true);
    expect(isClientScreenCodeVisible('basic.manager', set)).toBe(false);
    // field ticked but its tab is not
    expect(isClientScreenCodeVisible('details.n', set)).toBe(false);
    expect(isClientScreenCodeVisible('finance.paid', set)).toBe(false);
  });

  it('matches the backend OpenAPI ClientScreenCode enum', () => {
    const contract = load(
      readFileSync(new URL('../../../backend/contracts/04-api-contract.openapi.yaml', import.meta.url), 'utf8'),
    ) as { components: { schemas: { ClientScreenCode: { enum: string[] } } } };
    expect(contract.components.schemas.ClientScreenCode.enum).toEqual([...CLIENT_SCREEN_CODES]);
  });
});
