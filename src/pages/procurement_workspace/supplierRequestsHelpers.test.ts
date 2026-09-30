import { describe, expect, it } from 'vitest';
import type { ProcurementWorklistLine, WorklistRequestRef } from '../../api/types/procurementWorkspaceApi.types';
import type { CreateSupplierRequestDraftsResultDto, SupplierRequestCardDto } from '../../api/types/supplierRequestsApi.types';
import {
  buildDraftPreviewItems,
  buildDraftsBody,
  buildSupplierCopyText,
  buildUpdatePatchBody,
  clearDraftPreview,
  computeLineStock,
  computeRequestSteps,
  draftPreviewSignature,
  formatLineItemText,
  formatRequestQuantity,
  hasRequestSupplier,
  hasUnsavedRequestChanges,
  loadDraftRequestId,
  saveDraftRequestId,
  groupDraftPreviewBySupplier,
  hiddenOrdersLabel,
  isStockNegative,
  isWholeSheetQuantity,
  loadDraftPreview,
  requestRefTag,
  requestsStatusCounts,
  resolveDraftRequestId,
  roundTo3Number,
  saveDraftPreview,
  statusFilterToParam,
  summarizeDraftsResult,
  supplierRequestErrorMessage,
  type DraftPreviewItem,
  type StorageLike,
} from './supplierRequestsHelpers';

function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

function line(overrides: Partial<ProcurementWorklistLine>): ProcurementWorklistLine {
  return {
    lineKey: '1|sheet_material:8', orderId: 1, orderName: '2972', fullNumber: 'A-2972', clientName: 'Клиент', orderStatus: null,
    resourceKey: 'sheet_material:8', kind: 'sheet_material', refId: 8, name: 'МДФ 16мм', unit: 'm2', demandSource: 'cut', need: 10, received: 0,
    receivedIncompatibleCount: 0, covered: 0, orderedOpen: 0, requests: [], deficit: 10, coverage: 'none', needsAction: true, purchased: false,
    purchaseOrigin: null, demandChangedSinceMark: false, plannedCompletionDate: '2026-10-02', dueDate: '2026-09-30', daysLeft: 2,
    urgency: 'critical', supplier: { key: 's:1', name: 'Мебель-Трейд', source: 'material', others: [] },
    procurementVersion: 3, demandFingerprint: 'a'.repeat(64), onecReceiptCount: 0, lockedByOnec: false,
    ...overrides,
  };
}

describe('черновик заявок из выделения', () => {
  it('берёт только позиции с непокрытым дефицитом', () => {
    const lines = [line({ deficit: 5 }), line({ lineKey: '2', deficit: 0 }), line({ lineKey: '3', deficit: null })];
    expect(buildDraftPreviewItems(lines)).toHaveLength(1);
  });

  it('группирует по поставщику, затем по материалу, суммирует дефицит и собирает заказы без повторов', () => {
    const items: DraftPreviewItem[] = [
      { orderId: 1, resourceKey: 'sheet_material:8', supplierKey: 's:1', supplierName: 'Мебель-Трейд', materialName: 'МДФ 16мм', deficit: 5, unit: 'm2', fullNumber: 'A-1' },
      { orderId: 2, resourceKey: 'sheet_material:8', supplierKey: 's:1', supplierName: 'Мебель-Трейд', materialName: 'МДФ 16мм', deficit: 3, unit: 'm2', fullNumber: 'A-2' },
      { orderId: 3, resourceKey: 'film:4', supplierKey: 'none', supplierName: 'Не указан', materialName: 'Плёнка белая', deficit: 2, unit: 'lm', fullNumber: 'A-3' },
    ];
    const groups = groupDraftPreviewBySupplier(items);
    expect(groups).toHaveLength(2);
    expect(groups[0].supplierKey).toBe('s:1');
    expect(groups[0].materials).toEqual([{ resourceKey: 'sheet_material:8', materialName: 'МДФ 16мм', unit: 'm2', deficitTotal: 8, orders: ['A-1', 'A-2'] }]);
    // «Не указан» — последним.
    expect(groups[1].supplierKey).toBe('none');
  });

  it('отпечаток выделения не зависит от порядка позиций', () => {
    const a: DraftPreviewItem[] = [{ orderId: 1, resourceKey: 'x', supplierKey: 's', supplierName: '', materialName: '', deficit: 1, unit: 'm2', fullNumber: '' },
      { orderId: 2, resourceKey: 'y', supplierKey: 's', supplierName: '', materialName: '', deficit: 1, unit: 'm2', fullNumber: '' }];
    const b = [a[1], a[0]];
    expect(draftPreviewSignature(a)).toBe(draftPreviewSignature(b));
  });

  it('requestId переиспользуется при том же выделении и меняется при другом', () => {
    const items: DraftPreviewItem[] = [{ orderId: 1, resourceKey: 'x', supplierKey: 's', supplierName: '', materialName: '', deficit: 1, unit: 'm2', fullNumber: '' }];
    let calls = 0;
    const generate = () => `id-${++calls}`;
    const first = resolveDraftRequestId(items, null, generate);
    expect(first.requestId).toBe('id-1');
    const retry = resolveDraftRequestId(items, first, generate);
    expect(retry.requestId).toBe('id-1');
    const changed = resolveDraftRequestId([...items, { ...items[0], orderId: 2 }], retry, generate);
    expect(changed.requestId).toBe('id-2');
  });

  it('тело POST drafts дедуплицирует пары заказ+материал', () => {
    const items: DraftPreviewItem[] = [
      { orderId: 1, resourceKey: 'x', supplierKey: 's', supplierName: '', materialName: '', deficit: 1, unit: 'm2', fullNumber: '' },
      { orderId: 1, resourceKey: 'x', supplierKey: 's', supplierName: '', materialName: '', deficit: 1, unit: 'm2', fullNumber: '' },
    ];
    expect(buildDraftsBody(items, 'req-1')).toEqual({ requestId: 'req-1', items: [{ orderId: 1, resourceKey: 'x' }] });
  });

  it('итог создания: сообщение с номерами и пропуски по причинам', () => {
    const result: CreateSupplierRequestDraftsResultDto = {
      requests: [{ requestId: 1, requestNumber: '26-0001', supplierName: 'Мебель-Трейд', linesCount: 1, ordersCount: 1 }],
      skipped: [{ orderId: 2, resourceKey: 'x', reason: 'no_deficit' }, { orderId: 3, resourceKey: 'y', reason: 'no_deficit' }, { orderId: 4, resourceKey: 'z', reason: 'order_closed' }],
    };
    const summary = summarizeDraftsResult(result);
    expect(summary.createdMessage).toBe('Создано заявок: 1 (26-0001)');
    expect(summary.skippedMessage).toContain('Пропущено 3');
    expect(summary.skippedMessage).toContain('2 — дефицита больше нет');
    expect(summary.skippedMessage).toContain('1 — заказ закрыт или выдан');
  });

  it('без создания заявок сообщение — «не созданы», без пропусков — null', () => {
    expect(summarizeDraftsResult({ requests: [], skipped: [] }).createdMessage).toBe('Заявки не созданы');
    expect(summarizeDraftsResult({ requests: [{ requestId: 1, requestNumber: '26-0001', supplierName: '', linesCount: 1, ordersCount: 1 }], skipped: [] }).skippedMessage).toBeNull();
  });
});

describe('sessionStorage превью (StorageLike — без jsdom)', () => {
  it('сохраняет, загружает и чистит превью', () => {
    const storage = memoryStorage();
    const items: DraftPreviewItem[] = [{ orderId: 1, resourceKey: 'x', supplierKey: 's', supplierName: 'П', materialName: 'М', deficit: 1, unit: 'm2', fullNumber: 'A-1' }];
    expect(loadDraftPreview('7', storage)).toBeNull();
    saveDraftPreview('7', items, storage);
    expect(loadDraftPreview('7', storage)).toEqual(items);
    clearDraftPreview('7', storage);
    expect(loadDraftPreview('7', storage)).toBeNull();
  });

  it('игнорирует повреждённые данные', () => {
    const storage = memoryStorage();
    storage.setItem('procurement.supplierRequests.draftPreview:7', '{not json');
    expect(loadDraftPreview('7', storage)).toBeNull();
    storage.setItem('procurement.supplierRequests.draftPreview:7', JSON.stringify([{ foo: 'bar' }]));
    expect(loadDraftPreview('7', storage)).toBeNull();
  });
});

describe('список заявок: фильтр, счётчики, теги, сверка', () => {
  it('фильтр «Все» не передаёт статус, остальные — свой код', () => {
    expect(statusFilterToParam('all')).toBeUndefined();
    expect(statusFilterToParam('draft')).toBe('draft');
  });

  it('счётчики статусов складываются во «Все»', () => {
    expect(requestsStatusCounts({ draft: 2, sent: 1, closed: 3, cancelled: 0 })).toEqual({ draft: 2, sent: 1, closed: 3, cancelled: 0, all: 6 });
  });

  it('тег ссылки на заявку: draft — «в черновике», sent — «заказано»', () => {
    const draftRef: WorklistRequestRef = { requestId: 1, requestNumber: '26-0003', status: 'draft', supplierName: 'МТ', quantity: 5, unit: 'sheet' };
    const sentRef: WorklistRequestRef = { ...draftRef, status: 'sent' };
    expect(requestRefTag(draftRef)).toEqual({ tone: 'none', label: 'в черновике 26-0003' });
    expect(requestRefTag(sentRef)).toEqual({ tone: 'info', label: 'заказано · 26-0003' });
  });

  it('сверка: «Заявка» done у sent/closed, приход и оплата всегда «○» в этой фазе', () => {
    expect(computeRequestSteps('draft')).toEqual({ request: 'todo', receipt: 'todo', payment: 'todo' });
    expect(computeRequestSteps('sent')).toEqual({ request: 'done', receipt: 'todo', payment: 'todo' });
    expect(computeRequestSteps('closed')).toEqual({ request: 'done', receipt: 'todo', payment: 'todo' });
    expect(computeRequestSteps('cancelled')).toEqual({ request: 'todo', receipt: 'todo', payment: 'todo' });
  });

  it('«ещё N вне доступа» — только когда есть скрытые заказы', () => {
    expect(hiddenOrdersLabel(0)).toBeNull();
    expect(hiddenOrdersLabel(3)).toBe('ещё 3 вне доступа');
  });

  it('позиция списка «Материал — количество»: листы целыми, прочее — до тысячных', () => {
    expect(formatLineItemText({ name: 'МДФ 16мм', quantity: 7, unit: 'sheet' })).toBe('МДФ 16мм — 7 лист');
    expect(formatRequestQuantity(12.5, 'm2')).toBe('12,5 м²');
  });
});

describe('карточка: «на склад», правка строк, PATCH, текст для поставщика', () => {
  it('на склад = количество − сумма заказов (включая скрытые вне scope)', () => {
    expect(computeLineStock(10, [3, 2])).toBe(5);
    expect(computeLineStock(10, [3, 2], 4)).toBe(1);
    expect(computeLineStock(10, [10])).toBe(0);
  });

  it('отрицательный остаток определяется с запасом на погрешность округления', () => {
    expect(isStockNegative(-0.0001)).toBe(false);
    expect(isStockNegative(-0.01)).toBe(true);
    expect(isStockNegative(1)).toBe(false);
  });

  it('листы — только целые', () => {
    expect(isWholeSheetQuantity('sheet', 7)).toBe(true);
    expect(isWholeSheetQuantity('sheet', 7.5)).toBe(false);
    expect(isWholeSheetQuantity('m2', 7.5)).toBe(true);
  });

  it('округление до тысячных', () => {
    expect(roundTo3Number(1.23456)).toBe(1.235);
    expect(roundTo3Number(1)).toBe(1);
  });

  it('PATCH-тело: только переданные поля, числа округлены до тысячных', () => {
    const body = buildUpdatePatchBody({
      expectedVersion: 3,
      supplierId: null,
      lines: [{ lineId: 1, quantity: 10.12345, orders: [{ lineOrderId: 1, quantity: 3.98765 }] }],
    });
    expect(body).toEqual({
      expectedVersion: 3,
      supplierId: null,
      lines: [{ lineId: 1, quantity: 10.123, orders: [{ lineOrderId: 1, quantity: 3.988 }] }],
    });
    expect(buildUpdatePatchBody({ expectedVersion: 1 })).toEqual({ expectedVersion: 1 });
  });

  it('текст для поставщика: заявка, позиции, срок, комментарий — только если заданы', () => {
    const card: Pick<SupplierRequestCardDto, 'requestNumber' | 'supplierName' | 'lineItems' | 'expectedDate' | 'comment'> = {
      requestNumber: '26-0001',
      supplierName: 'Мебель-Трейд',
      lineItems: [{ lineId: 1, lineNo: 1, resourceKey: 'sheet_material:8', kind: 'sheet_material', refId: 8, name: 'МДФ 16мм', unit: 'sheet', demandUnit: 'm2', sheetAreaM2: 2.7, quantity: 7, stockQuantity: 0, orders: [], hiddenOrdersCount: 0, hiddenOrdersQuantity: 0 }],
      expectedDate: '2026-10-05',
      comment: 'Срочно',
    };
    expect(buildSupplierCopyText(card)).toBe('Заявка 26-0001 · Мебель-Трейд\nМДФ 16мм — 7 лист\nОжидаем к: 05.10.2026\nСрочно');
    expect(buildSupplierCopyText({ ...card, expectedDate: null, comment: null })).toBe('Заявка 26-0001 · Мебель-Трейд\nМДФ 16мм — 7 лист');
  });

  it('сообщение об ошибке команды — по коду, иначе — текст сервера, иначе — общее', () => {
    expect(supplierRequestErrorMessage({ code: 'SUPPLIER_REQUEST_SUPPLIER_REQUIRED' })).toBe('Укажите поставщика перед отправкой заявки');
    expect(supplierRequestErrorMessage({ code: 'UNKNOWN_CODE', message: 'что-то пошло не так' })).toBe('что-то пошло не так');
    expect(supplierRequestErrorMessage(null)).toBe('Не удалось выполнить операцию');
  });
});

describe('review R2 fixes', () => {
  function memoryStorage() {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  }

  it('CR2-5: доли листа по заказам и «на склад» показываются до тысячных', () => {
    expect(formatRequestQuantity(0.274, 'sheet')).toBe('0,274 лист');
    expect(formatRequestQuantity(0.726, 'sheet')).toBe('0,726 лист');
    expect(formatRequestQuantity(7, 'sheet')).toBe('7 лист');
  });

  it('CR2-3: ключ повтора переживает перемонтирование и переиспользуется для того же выделения', () => {
    const storage = memoryStorage();
    saveDraftRequestId('7', { signature: '1:film:2', requestId: 'abc' }, storage);
    const restored = loadDraftRequestId('7', storage);
    expect(restored).toEqual({ signature: '1:film:2', requestId: 'abc' });
    const items = [{ orderId: 1, resourceKey: 'film:2' }] as never;
    expect(resolveDraftRequestId(items, restored, () => 'new').requestId).toBe('abc');
    clearDraftPreview('7', storage);
    expect(loadDraftRequestId('7', storage)).toBeNull();
    storage.setItem('procurement.supplierRequests.draftRequestId:7', '{broken');
    expect(loadDraftRequestId('7', storage)).toBeNull();
  });

  it('CR2-1: поставщик из 1С (c:/n:) — это поставщик; правка без изменения поля его не трогает', () => {
    expect(hasRequestSupplier({ supplierKey: 'c:e146027a' })).toBe(true);
    expect(hasRequestSupplier({ supplierKey: 'n:abc' })).toBe(true);
    expect(hasRequestSupplier({ supplierKey: 's:3' })).toBe(true);
    expect(hasRequestSupplier({ supplierKey: 'none' })).toBe(false);
    const body = buildUpdatePatchBody({ expectedVersion: 2, comment: 'срочно', supplierId: undefined });
    expect('supplierId' in body).toBe(false);
  });
});

describe('hasUnsavedRequestChanges (CR3-2)', () => {
  const card = { comment: 'срочно', expectedDate: '2026-10-05' };
  const baseline = { 1: { quantity: 10, orders: { 11: 4, 12: 6 } } };
  const form = (overrides: Partial<Parameters<typeof hasUnsavedRequestChanges>[1]> = {}) => ({
    supplierTouched: false, comment: 'срочно', expectedDate: '2026-10-05', lineEdits: { 1: { quantity: 10, orders: { 11: 4, 12: 6 } } }, ...overrides,
  });

  it('нет правок — можно отправлять', () => {
    expect(hasUnsavedRequestChanges(card, form({ comment: ' срочно ' }), baseline)).toBe(false);
  });

  it('любая правка — количество, заказ, дата, комментарий, поставщик — блокирует отправку', () => {
    expect(hasUnsavedRequestChanges(card, form({ lineEdits: { 1: { quantity: 5, orders: { 11: 4, 12: 6 } } } }), baseline)).toBe(true);
    expect(hasUnsavedRequestChanges(card, form({ lineEdits: { 1: { quantity: 10, orders: { 11: 4 } } } }), baseline)).toBe(true);
    expect(hasUnsavedRequestChanges(card, form({ expectedDate: null }), baseline)).toBe(true);
    expect(hasUnsavedRequestChanges(card, form({ comment: '' }), baseline)).toBe(true);
    expect(hasUnsavedRequestChanges(card, form({ supplierTouched: true }), baseline)).toBe(true);
  });
});

describe('CR4-1: превью и ключ повтора изолированы по пользователю', () => {
  it('A сохранил превью и ключ, вышел; B в той же вкладке их не видит; A после F5 — видит', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    const items: DraftPreviewItem[] = [{ orderId: 1, resourceKey: 'film:2', supplierKey: 's:1', supplierName: 'П', materialName: 'М', deficit: 1, unit: 'lm', fullNumber: 'A-1' }];
    saveDraftPreview('A', items, storage);
    saveDraftRequestId('A', { signature: '1:film:2', requestId: 'req-a' }, storage);
    expect(loadDraftPreview('B', storage)).toBeNull();
    expect(loadDraftRequestId('B', storage)).toBeNull();
    expect(loadDraftPreview('A', storage)).toEqual(items);
    expect(loadDraftRequestId('A', storage)).toEqual({ signature: '1:film:2', requestId: 'req-a' });
  });
});
