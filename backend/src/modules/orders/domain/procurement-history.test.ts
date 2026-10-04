import { describe, expect, it } from 'vitest';
import { decodeHistoryCursor, encodeHistoryCursor, mapHistoryRow, nestedLineOrderIds, type ProcurementHistoryRow } from './procurement-history';

const base: ProcurementHistoryRow = {
  audit_id: '187cb766-908e-4751-ae24-6a99cdc0aa56',
  created_at: new Date('2026-10-01T10:00:00.123Z'),
  cursor_at: '2026-10-01T10:00:00.123456Z',
  event: 'order_resource.procurement_marked',
  actor_name: 'Снабженец',
  metadata_json: {},
  diff_json: null,
  after_json: null,
  allocation_unit: null,
  link_unit: null,
  doc_id: null,
  doc_kind: null,
  doc_number: null,
  doc_date: null,
};
const context = { orderId: 11631, resourceKey: 'sheet_material:8', canSeeAmounts: false };
const doc = { doc_id: '15601', doc_kind: 'bank_outflow', doc_number: 'НФНФ-003232', doc_date: '2026-09-22' };

describe('procurement history mapping (§5.6)', () => {
  it('a mark carries origin and the demand at mark', () => {
    const event = mapHistoryRow({ ...base, diff_json: {
      origin: { from: null, to: 'manual' }, quantityAtMark: { from: null, to: 3.38 }, unitAtMark: { from: null, to: 'm2' },
    } }, context)!;
    expect(event).toMatchObject({ kind: 'marked', origin: 'manual', quantity: 3.38, unit: 'm2', actorName: 'Снабженец', document: null });
    expect(event.at).toBe('2026-10-01T10:00:00.123Z');
  });

  it('a payment allocation shows its amount only with finance.view; a receipt shows quantity and the auto-mark', () => {
    const payment = { ...base, ...doc, event: 'order_resource.onec_allocation_added', metadata_json: { role: 'payment', amount: 1000, quantity: null, currency: 'KZT' } };
    expect(mapHistoryRow(payment, context)).toMatchObject({ kind: 'allocation_added', role: 'payment', amount: null, currency: null,
      document: { documentId: 15601, number: 'НФНФ-003232', date: '2026-09-22', docKind: 'bank_outflow' } });
    expect(mapHistoryRow(payment, { ...context, canSeeAmounts: true })).toMatchObject({ amount: 1000, currency: 'KZT' });
    // Событие без снимка валюты (до 4а) — валюта не подставляется из текущего документа (CR1-1).
    expect(mapHistoryRow({ ...payment, metadata_json: { role: 'payment', amount: 1000 } }, { ...context, canSeeAmounts: true }))
      .toMatchObject({ amount: 1000, currency: null });
    const receipt = { ...base, ...doc, event: 'order_resource.onec_allocation_added', allocation_unit: 'sheet',
      metadata_json: { role: 'receipt', quantity: 4, amount: null }, diff_json: { purchased: { from: false, to: true } } };
    expect(mapHistoryRow(receipt, { ...context, canSeeAmounts: true })).toMatchObject({ role: 'receipt', quantity: 4, unit: 'sheet', amount: null, markedPurchased: true });
    expect(mapHistoryRow({ ...receipt, event: 'order_resource.onec_allocation_removed' }, context)!.markedPurchased).toBe(false);
  });

  it('a request link shows the request and the receipt quantity in the request line unit (from either side of the diff)', () => {
    const linked = { ...base, event: 'order_resource.onec_allocation_linked_to_request', link_unit: 'sheet',
      metadata_json: { role: 'receipt', supplierRequestId: 20, requestNumber: '26-0017' },
      diff_json: { link: { from: null, to: { quantity: 0.5, lineOrderId: 21 } } } };
    expect(mapHistoryRow(linked, context)).toMatchObject({ kind: 'allocation_linked', quantity: 0.5, unit: 'sheet', request: { supplierRequestId: 20, number: '26-0017' } });
    const unlinked = { ...linked, event: 'order_resource.onec_allocation_unlinked_from_request', diff_json: { link: { from: { quantity: 0.5 }, to: null } } };
    expect(mapHistoryRow(unlinked, context)).toMatchObject({ kind: 'allocation_unlinked', quantity: 0.5 });
    const payment = { ...linked, metadata_json: { ...linked.metadata_json, role: 'payment' }, diff_json: { link: { from: null, to: { quantity: null } } } };
    expect(mapHistoryRow(payment, { ...context, canSeeAmounts: true })).toMatchObject({ role: 'payment', quantity: null, unit: null, amount: null });
  });

  it('a supplier request event shows only this order quantity, never other orders', () => {
    const after = { lines: [
      { resourceKey: 'sheet_material:8', unit: 'sheet', orders: [{ orderId: 11631, quantity: 0.187 }, { orderId: 999, quantity: 5 }] },
      { resourceKey: 'film:1', unit: 'lm', orders: [{ orderId: 11631, quantity: 7 }] },
    ] };
    const created = { ...base, event: 'procurement.supplier_request_created', after_json: after,
      metadata_json: { supplierRequestId: 20, requestNumber: '26-0017', orderIds: [11631, 999] } };
    const event = mapHistoryRow(created, context)!;
    expect(event).toMatchObject({ kind: 'request_created', quantity: 0.187, unit: 'sheet', request: { supplierRequestId: 20, number: '26-0017' } });
    expect(JSON.stringify(event)).not.toContain('999');
    // Заказ убран из заявки правкой — в снимке «после» его нет.
    expect(mapHistoryRow({ ...created, event: 'procurement.supplier_request_updated', after_json: { lines: [] } }, context))
      .toMatchObject({ kind: 'request_updated', quantity: null, unit: null });
  });

  it('links created with a batch allocation and removed with an allocation are listed with request number and unit (CR1-2)', () => {
    const lineOrders = new Map([[21, { number: '26-0017', unit: 'sheet' }], [22, { number: '26-0018', unit: 'm2' }]]);
    const added = { ...base, ...doc, event: 'order_resource.onec_allocation_added', allocation_unit: 'sheet',
      metadata_json: { role: 'receipt', quantity: 10, requestLinks: [
        { linkId: 1, lineOrderId: 21, supplierRequestId: 20, quantity: 5 },
        { linkId: 2, lineOrderId: 22, supplierRequestId: 30, quantity: 28.98 },
      ] } };
    expect(nestedLineOrderIds([added])).toEqual([21, 22]);
    expect(mapHistoryRow(added, { ...context, lineOrders })!.requestLinks).toEqual([
      { action: 'linked', supplierRequestId: 20, number: '26-0017', quantity: 5, unit: 'sheet' },
      { action: 'linked', supplierRequestId: 30, number: '26-0018', quantity: 28.98, unit: 'm2' },
    ]);
    const removed = { ...added, event: 'order_resource.onec_allocation_removed', metadata_json: { role: 'payment', amount: 5,
      removedRequestLinks: [{ linkId: 3, lineOrderId: 21, supplierRequestId: 20, quantity: null }] } };
    expect(mapHistoryRow(removed, { ...context, lineOrders })!.requestLinks).toEqual([
      { action: 'unlinked', supplierRequestId: 20, number: '26-0017', quantity: null, unit: null },
    ]);
  });

  it('unknown and denied events are skipped', () => {
    expect(mapHistoryRow({ ...base, event: 'order_resource.procurement_denied' }, context)).toBeNull();
  });

  it('cursor round-trip keeps microseconds; garbage is rejected', () => {
    const cursor = encodeHistoryCursor(base.cursor_at, base.audit_id);
    expect(decodeHistoryCursor(cursor)).toEqual({ at: base.cursor_at, id: base.audit_id });
    expect(decodeHistoryCursor('not-a-cursor')).toBeNull();
    expect(decodeHistoryCursor(Buffer.from(JSON.stringify(['x', 'y'])).toString('base64url'))).toBeNull();
    // 36 дефисов — не UUID; дата не в формате курсора — тоже (CR1-3).
    expect(decodeHistoryCursor(encodeHistoryCursor(base.cursor_at, '-'.repeat(36)))).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor('2026-10-01', base.audit_id))).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor('2026-02-30T00:00:00.000000Z', base.audit_id))).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor('2025-02-29T00:00:00.000000Z', base.audit_id))).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor('0000-01-01T00:00:00.000000Z', base.audit_id))).toBeNull();
    expect(decodeHistoryCursor(encodeHistoryCursor('2024-02-29T23:59:59.999999Z', base.audit_id))).not.toBeNull();
  });
});
