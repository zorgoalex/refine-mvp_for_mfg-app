import { describe, it, expect } from 'vitest';
import { toErpDateString } from './pg-crm-source-repository';

// ---------------------------------------------------------------------------
// toErpDateString — the date-only serializer for CRM source rows.
//
// Regression lock for the 2026-06-19 enablement defect: node-postgres parses a
// DATE column (OID 1082) into a JS Date constructed at LOCAL midnight, so the
// previous `String(v)` produced a `Date.prototype.toString()` value
// ("Fri Jun 19 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"). Feeding
// that to the mapper's `${d}T00:00:00.000Z` yielded a non-ISO string and Twenty
// rejected every order create/update with HTTP 400.
//
// These cases use `new Date(y, m, d)` (local midnight) exactly as pg builds a
// DATE value, so the assertions are timezone-independent.
// ---------------------------------------------------------------------------
describe('toErpDateString', () => {
  it('returns null for null', () => {
    expect(toErpDateString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toErpDateString(undefined)).toBeNull();
  });

  it('serializes a pg DATE (local-midnight Date) to YYYY-MM-DD', () => {
    // This is exactly what node-postgres hands back for a DATE column.
    expect(toErpDateString(new Date(2026, 0, 15))).toBe('2026-01-15');
    expect(toErpDateString(new Date(2026, 5, 19))).toBe('2026-06-19');
    expect(toErpDateString(new Date(2026, 11, 1))).toBe('2026-12-01');
  });

  it('NEVER returns a Date.toString() value', () => {
    const out = toErpDateString(new Date(2026, 5, 19));
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(out).not.toMatch(/GMT|Coordinated Universal Time|[A-Za-z]{3}\s/);
  });

  it('normalizes a date-only string to itself', () => {
    expect(toErpDateString('2026-01-15')).toBe('2026-01-15');
  });

  it('normalizes a longer ISO string to its date prefix', () => {
    expect(toErpDateString('2026-01-15T00:00:00.000Z')).toBe('2026-01-15');
  });
});
