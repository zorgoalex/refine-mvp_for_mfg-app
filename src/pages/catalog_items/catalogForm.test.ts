import { describe, expect, it } from 'vitest';
import { catalogDraft, catalogPayload, catalogFailureState, catalogCommandIdentity } from './catalogForm';
import { ApiError } from '../../api/apiError';
import { RESOURCE_PERMISSION_MAP } from '../../utils/navigationPermissions';
import type { CatalogInput } from '../../api/catalogApi';

describe('catalog form', () => {
  const input: CatalogInput = { name: ' Товар ', sku: ' ', unitId: 1, kind: 'stock_item', basePrice: null, description: '', isActive: true };
  it('keeps empty price distinct from zero and normalizes decimal comma', () => {
    expect(catalogPayload(input)).toMatchObject({ name: 'Товар', sku: null, basePrice: null });
    expect(catalogPayload({ ...input, basePrice: '0' }).basePrice).toBe('0.00');
    expect(catalogPayload({ ...input, basePrice: '12,5' }).basePrice).toBe('12.50');
    expect(() => catalogPayload({ ...input, basePrice: '0.001' })).toThrow();
  });
  it('does not invent an existing unit or Bitrix identity', () => {
    expect(catalogDraft()).toEqual({ name: '', sku: null, kind: 'service', basePrice: null, description: '', isActive: true, refKey1c: null, sortOrder: 100 });
    expect(RESOURCE_PERMISSION_MAP.catalog_items).toEqual(['references.view', 'references.manage']);
  });
  it('normalizes 1C key and sort order but never sends read-only audit fields', () => {
    expect(catalogPayload({ ...input, refKey1c: ' ABCDEF00-1234-0000-0000-000000000000 ', sortOrder: -2 })).toMatchObject({ refKey1c: 'abcdef00-1234-0000-0000-000000000000', sortOrder: -2 });
    expect(catalogPayload({ ...input, refKey1c: ' ' })).toMatchObject({ refKey1c: null, sortOrder: 100 });
    const extra = { ...input, createdBy: '999', editedBy: '999', createdAt: 'fake', version: 42, id: 88 };
    const payload = catalogPayload(extra);
    for (const field of ['createdBy', 'editedBy', 'createdAt', 'version', 'id']) expect(payload).not.toHaveProperty(field);
    expect(() => catalogPayload({ ...input, refKey1c: 'not-uuid' })).toThrow('UUID');
    for (const sortOrder of [-32769, 32768, 1.5]) expect(() => catalogPayload({ ...input, sortOrder })).toThrow('Порядок');
  });
  it('unfreezes definitive failure after same-key unknown-result retry without changing draft', () => {
    const draft = { ...input, name: 'Несохранённый текст' };
    const fingerprint = JSON.stringify(draft);
    const identity = catalogCommandIdentity(undefined, fingerprint);
    expect(catalogFailureState(new Error('fetch failed'), true)).toMatchObject({ uncertain: true, stale: false });
    expect(catalogCommandIdentity(identity, fingerprint)).toBe(identity);
    expect(catalogFailureState(new ApiError({ status: 409, code: 'CATALOG_VERSION_CONFLICT', message: 'Загрузите версию' }), true)).toEqual({ uncertain: false, stale: true, message: 'Загрузите версию' });
    expect(JSON.stringify(draft)).toBe(fingerprint);
    for (const status of [401, 403, 422]) expect(catalogFailureState(new ApiError({ status, code: 'DENIED', message: 'error' }), true).uncertain).toBe(false);
    expect(catalogFailureState(new ApiError({ status: 500, code: 'INTERNAL', message: 'error' }), true).uncertain).toBe(true);
    expect(catalogFailureState(new Error('invalid price'), false).uncertain).toBe(false);
  });
});
