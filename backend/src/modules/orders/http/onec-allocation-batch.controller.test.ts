import { describe, expect, it } from 'vitest';
import { OnecDocumentsService } from '../application/onec-documents.service';
import { batchSchema } from './onec-documents.controller';

const item = {
  lineId: 1, orderId: 2, resourceKey: 'sheet_material:8', quantity: 1.5,
  expectedVersion: 0, expectedDemandFingerprint: 'a'.repeat(64), expectedDocUnit: 'm2', expectedSheetAreaM2: 5.796,
};
const body = { requestId: '11111111-1111-4111-8111-111111111111', origin: 'suggested', items: [item] };

describe('batch allocation body', () => {
  it('accepts a valid body', () => {
    expect(batchSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ['more than 3 decimals', { ...body, items: [{ ...item, quantity: 1.0005 }] }],
    ['zero quantity', { ...body, items: [{ ...item, quantity: 0 }] }],
    ['request links before phase 3', { ...body, items: [{ ...item, requestLinks: [] }] }],
    ['unknown origin', { ...body, origin: 'auto' }],
    ['no items', { ...body, items: [] }],
    ['101 items', { ...body, items: Array.from({ length: 101 }, (_, index) => ({ ...item, lineId: index + 1 })) }],
    ['bad fingerprint', { ...body, items: [{ ...item, expectedDemandFingerprint: 'x' }] }],
    ['missing unit context', { ...body, items: [{ ...item, expectedDocUnit: undefined }] }],
    ['unknown doc unit', { ...body, items: [{ ...item, expectedDocUnit: 'kg' }] }],
    ['non-uuid request id', { ...body, requestId: 'abc' }],
  ])('rejects %s', (_name, value) => {
    expect(batchSchema.safeParse(value).success).toBe(false);
  });
});

describe('OnecDocumentsService batch and suggestions permissions', () => {
  const documents = {
    list: async () => ({}) as never,
    getCard: async () => ({}) as never,
    addAllocation: async () => ({}) as never,
    removeAllocation: async () => ({}) as never,
    addAllocationsBatch: async () => ({ changed: true, results: [], lines: [] }),
  };
  const suggestions = { allocationSuggestions: async () => ({ documentId: 1, number: '1', date: '2026-09-29', supplierName: null, wastePercent: 5, proposalLimit: 100, proposalLimitReached: false, lines: [] }) };
  const user = (permissions: string[]) => ({ id: '5', username: 'u', role: 'manager', roleId: 10, permissions });

  it('batch requires procurement.manage literally and records the denial', async () => {
    const denied: unknown[] = [];
    const auditClient = { query: async (_sql: string, params: unknown[]) => { denied.push(params); return { rows: [], rowCount: 1 }; } };
    const service = new OnecDocumentsService({ documents, suggestions, auditClient: auditClient as never });
    await expect(service.addAllocationsBatch({ currentUser: user(['procurement.view']), documentId: 1, requestId: 'r', origin: 'suggested', items: [] }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(denied.length).toBeGreaterThan(0);
    await expect(service.addAllocationsBatch({ currentUser: user(['procurement.manage']), documentId: 1, requestId: 'r', origin: 'suggested', items: [] }))
      .resolves.toMatchObject({ changed: true });
  });

  it('suggestions need procurement.view and procurement.manage', async () => {
    const service = new OnecDocumentsService({ documents, suggestions });
    await expect(service.allocationSuggestions(user(['procurement.manage']), 1, 'r')).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.allocationSuggestions(user(['procurement.view']), 1, 'r')).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.allocationSuggestions(user(['procurement.view', 'procurement.manage']), 1, 'r')).resolves.toMatchObject({ documentId: 1 });
  });
});
