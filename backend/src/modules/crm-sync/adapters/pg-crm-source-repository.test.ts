import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { PgCrmSourceRepository, toErpDateString } from './pg-crm-source-repository';

// ---------------------------------------------------------------------------
// toErpDateString — the date-only serializer for CRM source rows.
//
// Regression lock for the 2026-06-19 enablement defect: node-postgres parses a
// DATE column (OID 1082) into a JS Date constructed at LOCAL midnight, so the
// previous `String(v)` produced a `Date.prototype.toString()` value
// ("Fri Jun 19 2026 00:00:00 GMT+0000 (Coordinated Universal Time)"). Feeding
// that to the mapper's `${d}T00:00:00.000Z` yielded a non-ISO Bitrix24 value
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

describe('PgCrmSourceRepository Bitrix24 projection reads', () => {
  it('loads person type and ordered client phones', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          client_id: 7,
          client_name: 'ТОО Мебель',
          person_type: 'legal',
          notes: 'Важно',
          is_active: true,
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          { phone_number: '+77001112233', phone_type: 'work', is_primary: true },
          { phone_number: '+77004445566', phone_type: 'unknown', is_primary: false },
        ],
      });
    const source = new PgCrmSourceRepository({ query } as unknown as DatabaseService);

    await expect(source.getClientById('7')).resolves.toEqual({
      clientId: '7',
      clientName: 'ТОО Мебель',
      personType: 'legal',
      notes: 'Важно',
      isActive: true,
      phones: [
        { phoneNumber: '+77001112233', phoneType: 'work', isPrimary: true },
        { phoneNumber: '+77004445566', phoneType: 'mobile', isPrimary: false },
      ],
    });
    expect(query.mock.calls[1]?.[0]).toContain('ORDER BY is_primary DESC');
  });

  it('loads only non-deleted ERP payments and normalizes dates and amounts', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        payment_id: 31,
        order_id: 20,
        type_paid_id: 2,
        type_paid_name: 'Банк',
        amount: '125000.50',
        payment_date: new Date(2026, 6, 20),
        notes: null,
      }],
    });
    const source = new PgCrmSourceRepository({ query } as unknown as DatabaseService);

    await expect(source.getPaymentsByOrderId('20')).resolves.toEqual([{
      paymentId: '31',
      orderId: '20',
      typePaidId: '2',
      typePaidName: 'Банк',
      amount: 125000.5,
      paymentDate: '2026-07-20',
      notes: null,
    }]);
    expect(query.mock.calls[0]?.[0]).toContain('p.delete_flag = false');
  });

  it('checks all ERP orders, including soft-deleted ones, before deleting a client', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ has_orders: true }] });
    const source = new PgCrmSourceRepository({ query } as unknown as DatabaseService);

    await expect(source.hasOrdersForClient('7')).resolves.toBe(true);
    expect(query.mock.calls[0]?.[0]).not.toContain('delete_flag');
  });
});
