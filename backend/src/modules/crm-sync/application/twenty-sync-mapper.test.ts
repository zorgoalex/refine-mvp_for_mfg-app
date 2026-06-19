import { describe, it, expect } from 'vitest';
import { erpStatusFor, mapClient, mapOrder, hash } from './twenty-sync-mapper';
import type { ClientRow, OrderRow } from './crm-sync.types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const activeClient: ClientRow = {
  clientId: 'c-001',
  clientName: 'Acme Corp',
  notes: 'some notes',
  isActive: true,
};

const inactiveClient: ClientRow = {
  clientId: 'c-002',
  clientName: 'Old Corp',
  notes: null,
  isActive: false,
};

const fullOrder: OrderRow = {
  orderId: 'o-001',
  orderNumber: 'ORD-42',
  orderName: 'Order #42',
  clientId: 'c-001',
  totalAmount: 1000,
  finalAmount: 900,
  paidAmount: 450,
  orderStatusName: 'В работе',
  paymentStatusName: 'Частично оплачен',
  orderDate: '2026-01-15',
  completionDate: '2026-03-01',
  deleteFlag: false,
};

const deletedOrder: OrderRow = {
  ...fullOrder,
  orderId: 'o-002',
  deleteFlag: true,
};

const nullFieldsOrder: OrderRow = {
  orderId: 'o-003',
  orderNumber: 'ORD-0',
  orderName: 'Bare Order',
  clientId: 'c-001',
  totalAmount: null,
  finalAmount: null,
  paidAmount: null,
  orderStatusName: null,
  paymentStatusName: null,
  orderDate: null,
  completionDate: null,
  deleteFlag: false,
};

// ---------------------------------------------------------------------------
// erpStatusFor
// ---------------------------------------------------------------------------
describe('erpStatusFor', () => {
  it('returns active when isDeleted is false', () => {
    expect(erpStatusFor(false)).toBe('active');
  });

  it('returns deleted when isDeleted is true', () => {
    expect(erpStatusFor(true)).toBe('deleted');
  });
});

// ---------------------------------------------------------------------------
// mapClient
// ---------------------------------------------------------------------------
describe('mapClient', () => {
  it('maps active client to erpStatus active', () => {
    const result = mapClient(activeClient);
    expect(result.erpStatus).toBe('active');
  });

  it('maps inactive client to erpStatus deleted', () => {
    const result = mapClient(inactiveClient);
    expect(result.erpStatus).toBe('deleted');
  });

  it('maps name and erpId correctly', () => {
    const result = mapClient(activeClient);
    expect(result.name).toBe('Acme Corp');
    expect(result.erpId).toBe('c-001');
  });

  it('contains ONLY name, erpId, erpStatus keys — no notes key', () => {
    const result = mapClient(activeClient);
    const keys = Object.keys(result).sort();
    expect(keys).toEqual(['erpId', 'erpStatus', 'name']);
    expect('notes' in result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapOrder
// ---------------------------------------------------------------------------
describe('mapOrder', () => {
  const COMPANY_ID = 'twenty-company-uuid';

  it('maps all ErpOrder fields for a full order', () => {
    const result = mapOrder(fullOrder, COMPANY_ID);
    expect(result.name).toBe('Order #42');
    expect(result.erpId).toBe('o-001');
    expect(result.erpStatus).toBe('active');
    expect(result.orderNumber).toBe('ORD-42');
    expect(result.orderStatus).toBe('В работе');
    expect(result.paymentStatus).toBe('Частично оплачен');
    expect(result.totalAmount).toBe(1000);
    expect(result.finalAmount).toBe(900);
    expect(result.paidAmount).toBe(450);
    expect(result.orderDate).toBe('2026-01-15T00:00:00.000Z');
    expect(result.completionDate).toBe('2026-03-01T00:00:00.000Z');
    expect(result.companyId).toBe(COMPANY_ID);
  });

  it('maps deleteFlag true to erpStatus deleted', () => {
    const result = mapOrder(deletedOrder, COMPANY_ID);
    expect(result.erpStatus).toBe('deleted');
  });

  it('passes null amounts through as null', () => {
    const result = mapOrder(nullFieldsOrder, COMPANY_ID);
    expect(result.totalAmount).toBeNull();
    expect(result.finalAmount).toBeNull();
    expect(result.paidAmount).toBeNull();
  });

  it('passes null dates through as null', () => {
    const result = mapOrder(nullFieldsOrder, COMPANY_ID);
    expect(result.orderDate).toBeNull();
    expect(result.completionDate).toBeNull();
  });

  it('converts non-null date strings to ISO datetime', () => {
    const result = mapOrder(fullOrder, COMPANY_ID);
    expect(result.orderDate).toMatch(/T00:00:00\.000Z$/);
    expect(result.completionDate).toMatch(/T00:00:00\.000Z$/);
  });

  it('includes companyId in the payload', () => {
    const result = mapOrder(fullOrder, COMPANY_ID);
    expect(result.companyId).toBe(COMPANY_ID);
  });

  // Regression lock (2026-06-19): the projected date-time MUST be a strict ISO
  // string Twenty accepts ('YYYY-MM-DDTHH:mm:ssZ'), never a Date.toString().
  const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

  it('projects strict ISO date-time for non-null dates', () => {
    const result = mapOrder(fullOrder, COMPANY_ID);
    expect(result.orderDate).toMatch(ISO_DATETIME);
    expect(result.completionDate).toMatch(ISO_DATETIME);
  });

  it('fails fast when orderDate is a non-date string (e.g. a leaked Date.toString())', () => {
    const leaked: OrderRow = {
      ...fullOrder,
      orderDate: 'Fri Jun 19 2026 00:00:00 GMT+0000 (Coordinated Universal Time)',
    };
    expect(() => mapOrder(leaked, COMPANY_ID)).toThrow(/YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------
describe('hash', () => {
  it('is deterministic — same payload, different key insertion order → same hash', () => {
    const payloadA: Record<string, unknown> = { name: 'Acme', erpId: 'c-001', erpStatus: 'active' };
    const payloadB: Record<string, unknown> = { erpStatus: 'active', erpId: 'c-001', name: 'Acme' };
    expect(hash(payloadA)).toBe(hash(payloadB));
  });

  it('returns different hash for different payloads', () => {
    const p1 = mapClient(activeClient);
    const p2 = mapClient(inactiveClient);
    expect(hash(p1)).not.toBe(hash(p2));
  });

  it('returns a non-empty hex string', () => {
    expect(hash({ x: 1 })).toMatch(/^[0-9a-f]+$/);
  });
});
