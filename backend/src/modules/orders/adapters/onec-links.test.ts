import { describe, expect, it } from 'vitest';
import {
  applyProcurement,
  isReceiptLock,
  orphanLine,
  procurementRowKey,
  resourceKey,
  type OnecLinkRow,
  type ProjectedOrder,
  type ProjectedResourceLine,
  type ResourceProcurementRow,
} from './pg-order-resource-demand-repository';
import { decide } from './pg-order-resource-procurement-repository';

// --- fixtures -------------------------------------------------------------

function demandLine(overrides: Partial<ProjectedResourceLine> = {}): ProjectedResourceLine {
  return {
    resourceKey: 'sheet_material:11',
    kind: 'sheet_material',
    refId: 11,
    name: 'E2E-Тест ЛДСП Белая',
    supplierName: 'E2E-Тест Поставщик Листов',
    quantity: 5,
    unit: 'm2',
    areaM2: 5,
    detailsCount: 2,
    source: 'area',
    demandFingerprint: 'fp-real',
    details: [],
    ...overrides,
  };
}

function procurementRow(overrides: Partial<ResourceProcurementRow> = {}): ResourceProcurementRow {
  return {
    order_resource_procurement_id: 9001,
    order_id: 101,
    resource_kind: 'sheet_material',
    sheet_material_type_id: 11,
    film_id: null,
    resource_name: 'E2E-Тест ЛДСП Белая',
    purchased: true,
    origin: 'manual',
    quantity_at_mark: 5,
    unit_at_mark: 'm2',
    demand_fingerprint_at_mark: 'fp-real',
    marked_at: '2026-09-01T00:00:00.000Z',
    marked_by: 7,
    marked_by_name: 'E2E-Тест Менеджер',
    version: 1,
    ...overrides,
  };
}

function onecLink(overrides: Partial<OnecLinkRow> = {}): OnecLinkRow {
  const row = {
    allocation_id: 5001,
    order_resource_procurement_id: 9001,
    role: 'receipt',
    quantity: 3,
    amount: 15000,
    origin: 'manual',
    onec_document_id: 7001,
    doc_kind: 'purchase_receipt',
    number: 'E2E-Тест П-100',
    doc_date: '2026-09-01',
    posted: true,
    deleted_in_onec: false,
    ...overrides,
  };
  // Состояние документа — как в onecStateSql: удалён / не проведён, иначе действует (если не задано явно).
  const state = overrides.doc_state ?? (row.deleted_in_onec ? 'deleted' : !row.posted ? 'unposted' : 'active');
  return { ...row, doc_state: state } as OnecLinkRow;
}

function projectedOrder(orderId: number, lines: ProjectedResourceLine[]): ProjectedOrder {
  return {
    orderId,
    base: {
      orderId,
      orderName: `E2E-Тест Заказ ${orderId}`,
      fullNumber: `МП-${orderId}`,
      orderDate: '2026-09-01',
      projectCode: 'МП',
      clientName: 'E2E-Тест Клиент Иванов',
      updatedAt: '2026-09-01T00:00:00.000Z',
      sheetMaterials: [],
      films: [],
    },
    lines,
  };
}

// --- isReceiptLock ----------------------------------------------------------

describe('isReceiptLock', () => {
  it('is true only for a posted, not-deleted receipt link', () => {
    expect(isReceiptLock(onecLink({ role: 'receipt', posted: true, deleted_in_onec: false }))).toBe(true);
  });

  it('is false for a payment link, even posted and not deleted', () => {
    expect(isReceiptLock(onecLink({ role: 'payment', posted: true, deleted_in_onec: false }))).toBe(false);
  });

  it('is false for an unposted receipt link', () => {
    expect(isReceiptLock(onecLink({ role: 'receipt', posted: false, deleted_in_onec: false }))).toBe(false);
  });

  it('is false for a receipt link from a document deleted in 1C', () => {
    expect(isReceiptLock(onecLink({ role: 'receipt', posted: true, deleted_in_onec: true }))).toBe(false);
  });
});

// --- applyProcurement: onec split + amount masking + lockedByOnec ---------

describe('applyProcurement — onec receipts/payments split and locking', () => {
  it('splits active links into onec.receipts and onec.payments by role', () => {
    const receipt = onecLink({ allocation_id: 1, role: 'receipt' });
    const payment = onecLink({ allocation_id: 2, role: 'payment', onec_document_id: 7002, doc_kind: 'cash_outflow', number: 'E2E-Тест РКО-1' });
    const [{ line }] = applyProcurement([demandLine()], [procurementRow()], { onecLinks: [receipt, payment] });

    expect(line.onec.receipts).toHaveLength(1);
    expect(line.onec.receipts[0]).toMatchObject({ allocationId: 1, documentId: 7001, kind: 'purchase_receipt' });
    expect(line.onec.payments).toHaveLength(1);
    expect(line.onec.payments[0]).toMatchObject({ allocationId: 2, documentId: 7002, kind: 'cash_outflow' });
  });

  it('sets lockedByOnec true when an active receipt link is posted and not deleted', () => {
    const [{ line }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ role: 'receipt', posted: true, deleted_in_onec: false })],
    });
    expect(line.lockedByOnec).toBe(true);
  });

  it('leaves lockedByOnec false when the only link is a payment', () => {
    const [{ line }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ role: 'payment' })],
    });
    expect(line.lockedByOnec).toBe(false);
  });

  it('leaves lockedByOnec false when the receipt document is unposted or deleted', () => {
    const [{ line: unposted }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ role: 'receipt', posted: false })],
    });
    expect(unposted.lockedByOnec).toBe(false);

    const [{ line: deleted }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ role: 'receipt', deleted_in_onec: true })],
    });
    expect(deleted.lockedByOnec).toBe(false);
  });

  it('masks amount to null without finance.view (canSeeAmounts false/absent)', () => {
    const [{ line }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ amount: 42_000 })],
    });
    expect(line.onec.receipts[0].amount).toBeNull();
  });

  it('reveals amount with canSeeAmounts true', () => {
    const [{ line }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ amount: 42_000 })],
      canSeeAmounts: true,
    });
    expect(line.onec.receipts[0].amount).toBe(42_000);
  });

  it('never masks quantity, only amount', () => {
    const [{ line }] = applyProcurement([demandLine()], [procurementRow()], {
      onecLinks: [onecLink({ quantity: 3.5, amount: 42_000 })],
    });
    expect(line.onec.receipts[0].quantity).toBe(3.5);
    expect(line.onec.receipts[0].amount).toBeNull();
  });

  it('only attaches links whose order_resource_procurement_id matches the row', () => {
    const otherRow = procurementRow({ order_resource_procurement_id: 9999, sheet_material_type_id: 22, resource_name: 'Другой' });
    const otherLine = demandLine({ resourceKey: resourceKey('sheet_material', 22), refId: 22, name: 'Другой' });
    const [{ line: matched }, { line: unmatched }] = applyProcurement(
      [demandLine(), otherLine],
      [procurementRow(), otherRow],
      { onecLinks: [onecLink({ order_resource_procurement_id: 9001 })] },
    );
    expect(matched.onec.receipts).toHaveLength(1);
    expect(unmatched.onec.receipts).toHaveLength(0);
    expect(unmatched.lockedByOnec).toBe(false);
  });

  it('gives a line with no matching procurement row empty onec and lockedByOnec false', () => {
    const [{ line }] = applyProcurement([demandLine()], [], { onecLinks: [onecLink()] });
    expect(line.onec).toEqual({ receipts: [], payments: [] });
    expect(line.lockedByOnec).toBe(false);
  });
});

// --- orphanLine -------------------------------------------------------------

describe('orphanLine', () => {
  it('marks the line orphan:true and preserves the purchased procurement state', () => {
    const row = procurementRow({ purchased: true });
    const line = orphanLine(row);
    expect(line.orphan).toBe(true);
    expect(line.procurement.purchased).toBe(true);
    expect(line.quantity).toBe(0);
    expect(line.detailsCount).toBe(0);
  });

  it('attaches onec receipts/payments and lockedByOnec from extras like a live line', () => {
    const row = procurementRow({ purchased: true });
    const line = orphanLine(row, { onecLinks: [onecLink({ role: 'receipt', posted: true, deleted_in_onec: false })] });
    expect(line.onec.receipts).toHaveLength(1);
    expect(line.lockedByOnec).toBe(true);
  });

  it('masks amount on the orphan line the same way as a live line', () => {
    const row = procurementRow({ purchased: true });
    const masked = orphanLine(row, { onecLinks: [onecLink({ amount: 9_000 })] });
    expect(masked.onec.receipts[0].amount).toBeNull();

    const visible = orphanLine(row, { onecLinks: [onecLink({ amount: 9_000 })], canSeeAmounts: true });
    expect(visible.onec.receipts[0].amount).toBe(9_000);
  });

  it('resolves resourceKey/kind/refId for a film row the same as procurementRowKey', () => {
    const row = procurementRow({ resource_kind: 'film', sheet_material_type_id: null, film_id: 33, resource_name: 'E2E-Тест Плёнка' });
    const line = orphanLine(row);
    expect(line.resourceKey).toBe(procurementRowKey(row));
    expect(line.kind).toBe('film');
    expect(line.refId).toBe(33);
    expect(line.unit).toBe('lm');
  });
});

// --- decide: PROCUREMENT_LOCKED_BY_ONEC precedence --------------------------

describe('decide — PROCUREMENT_LOCKED_BY_ONEC', () => {
  const resourceKeyValue = 'sheet_material:11';

  it('rejects unmarking a purchased row locked by an active, posted, not-deleted receipt', () => {
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'receipt', posted: true, deleted_in_onec: false })];
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result).toMatchObject({ type: 'conflict', code: 'PROCUREMENT_LOCKED_BY_ONEC' });
  });

  it('allows unmarking when the receipt document was deleted in 1C', () => {
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'receipt', posted: true, deleted_in_onec: true })];
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result.type).toBe('apply');
  });

  it('allows unmarking when the receipt document is not yet posted', () => {
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'receipt', posted: false })];
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result.type).toBe('apply');
  });

  it('allows unmarking when the only active link is a payment, not a receipt', () => {
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'payment' })];
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, false, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result.type).toBe('apply');
  });

  it('the repeat-noop check takes priority over an onec lock (marking already-purchased stays a no-op)', () => {
    const row = procurementRow({ purchased: true, version: 1, demand_fingerprint_at_mark: 'fp-real' });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'receipt', posted: true, deleted_in_onec: false })];
    // Same target state (purchased:true) as current -> no-op, must not evaluate the lock at all.
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, true, { expectedVersion: 1, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result.type).toBe('noop');
  });

  it('the version-conflict check takes priority over an onec lock', () => {
    const row = procurementRow({ purchased: true, version: 5, demand_fingerprint_at_mark: 'fp-real' });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'receipt', posted: true, deleted_in_onec: false })];
    // Stale expectedVersion while attempting to unmark -> version conflict, not the onec lock.
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, false, { expectedVersion: 0, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result).toMatchObject({ type: 'conflict', code: 'PROCUREMENT_VERSION_CONFLICT' });
  });

  it('never locks when marking (purchased:true), only when unmarking', () => {
    const row = procurementRow({ purchased: false, version: 2 });
    const demand = [demandLine({ demandFingerprint: 'fp-real' })];
    const links = [onecLink({ role: 'receipt', posted: true, deleted_in_onec: false })];
    const result = decide(projectedOrder(101, demand), [row], resourceKeyValue, true, { expectedVersion: 2, expectedDemandFingerprint: 'fp-real' }, links);
    expect(result.type).toBe('apply');
  });
});

describe('orphan rows with active 1C allocations stay visible (R1)', () => {
  it('shows an unpurchased orphan while a document is still allocated to it, so it can be removed', () => {
    const row = procurementRow({ purchased: false, origin: null, demand_fingerprint_at_mark: null, marked_at: null });
    const link = onecLink({ role: 'payment', order_resource_procurement_id: row.order_resource_procurement_id });
    const withLink = applyProcurement([], [row], { onecLinks: [link], canSeeAmounts: true });
    expect(withLink).toHaveLength(1);
    expect(withLink[0].line).toMatchObject({ orphan: true, procurement: { purchased: false } });
    expect(withLink[0].line.onec.payments).toHaveLength(1);
    expect(applyProcurement([], [row], { onecLinks: [] })).toHaveLength(0);
  });
});

describe('isReceiptLock — documents that no longer count in 1C (2026-10-02)', () => {
  it('a receipt from a document missing from the 1C export, changed kind or with a removed line does not lock; a conflict still locks', () => {
    for (const state of ['missing', 'kind_changed', 'line_removed'] as const) {
      expect(isReceiptLock(onecLink({ role: 'receipt', doc_state: state }))).toBe(false);
    }
    expect(isReceiptLock(onecLink({ role: 'receipt', doc_state: 'conflict' }))).toBe(true);
  });
});
