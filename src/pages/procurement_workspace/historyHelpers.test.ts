import { describe, expect, it } from 'vitest';
import type { ProcurementHistoryCurrent, ProcurementHistoryEvent } from '../../api/types/procurementHistoryApi.types';
import {
  currentSummaryLines,
  eventUnitLabel,
  formatEventAmount,
  historyRequestLinkLabels,
  formatEventQuantity,
  historyDocumentLabel,
  historyEventTitle,
  originLabel,
  sortHistoryEventsDesc,
} from './historyHelpers';

function event(overrides: Partial<ProcurementHistoryEvent>): ProcurementHistoryEvent {
  return {
    id: 'e1',
    at: '2026-09-30T10:00:00.000Z',
    kind: 'marked',
    actorName: 'Оператор',
    origin: null,
    role: null,
    quantity: null,
    unit: null,
    amount: null,
    currency: null,
    markedPurchased: false,
    document: null,
    request: null,
    ...overrides,
  };
}

describe('eventUnitLabel / formatEventQuantity', () => {
  it('знает коды 1С и единицы потребности', () => {
    expect(eventUnitLabel('sheet')).toBe('лист');
    expect(eventUnitLabel('m2')).toBe('м²');
    expect(eventUnitLabel('lm')).toBe('пог. м');
    expect(eventUnitLabel('pcs')).toBe('шт');
    expect(eventUnitLabel(null)).toBe('');
  });

  it('неизвестный код выводится как есть', () => {
    expect(eventUnitLabel('упак')).toBe('упак');
  });

  it('форматирует количество с единицей', () => {
    expect(formatEventQuantity(7, 'sheet')).toBe('7 лист');
    expect(formatEventQuantity(12.5, 'm2')).toBe('12,5 м²');
    expect(formatEventQuantity(1, null)).toBe('1');
  });
});

describe('formatEventAmount / originLabel', () => {
  it('сумма с валютой операции; без снимка валюты — только число', () => {
    expect(formatEventAmount(50000, 'KZT')).toBe('50 000 ₸');
    expect(formatEventAmount(50000, null)).toBe('50 000');
    expect(formatEventAmount(120, 'USD')).toBe('120 USD');
  });

  it('подпись источника', () => {
    expect(originLabel('manual')).toBe('вручную');
    expect(originLabel('onec')).toBe('приходом 1С');
    expect(originLabel(null)).toBe('');
  });
});

describe('historyEventTitle', () => {
  it('marked: вручную с потребностью', () => {
    const title = historyEventTitle(event({ kind: 'marked', origin: 'manual', quantity: 10, unit: 'm2' }));
    expect(title).toBe('Отмечено «Закуплено» вручную — потребность 10 м²');
  });

  it('marked: приходом 1С без потребности', () => {
    const title = historyEventTitle(event({ kind: 'marked', origin: 'onec' }));
    expect(title).toBe('Отмечено «Закуплено» приходом 1С');
  });

  it('unmarked', () => {
    expect(historyEventTitle(event({ kind: 'unmarked' }))).toBe('Снята отметка «Закуплено»');
  });

  it('allocation_added: приход с отметкой «Закуплено»', () => {
    const title = historyEventTitle(event({
      kind: 'allocation_added', role: 'receipt', quantity: 5, unit: 'sheet', markedPurchased: true,
    }));
    expect(title).toBe('Приход распределён — 5 лист — отмечено «Закуплено»');
  });

  it('allocation_removed: приход без отметки', () => {
    const title = historyEventTitle(event({ kind: 'allocation_removed', role: 'receipt', quantity: 5, unit: 'sheet' }));
    expect(title).toBe('Распределение прихода снято — 5 лист');
  });

  it('allocation_added: оплата с суммой', () => {
    const title = historyEventTitle(event({ kind: 'allocation_added', role: 'payment', amount: 20000, currency: 'KZT' }));
    expect(title).toBe('Оплата распределена — 20 000 ₸');
  });

  it('allocation_removed: оплата без суммы', () => {
    const title = historyEventTitle(event({ kind: 'allocation_removed', role: 'payment', amount: null }));
    expect(title).toBe('Распределение оплаты снято');
  });

  it('allocation_linked: приход к заявке с количеством', () => {
    const title = historyEventTitle(event({
      kind: 'allocation_linked', role: 'receipt', quantity: 3, unit: 'sheet',
      request: { supplierRequestId: 17, number: '26-0017' },
    }));
    expect(title).toBe('Приход привязан к заявке 26-0017 — 3 лист');
  });

  it('allocation_unlinked: оплата отвязана от заявки (без количества)', () => {
    const title = historyEventTitle(event({
      kind: 'allocation_unlinked', role: 'payment',
      request: { supplierRequestId: 17, number: '26-0017' },
    }));
    expect(title).toBe('Оплата отвязана от заявки 26-0017');
  });

  it('allocation_linked: заявка без номера падает на #id', () => {
    const title = historyEventTitle(event({
      kind: 'allocation_linked', role: 'receipt', request: { supplierRequestId: 42, number: null },
    }));
    expect(title).toBe('Приход привязан к заявке #42');
  });

  it.each([
    ['request_created', 'создана'],
    ['request_updated', 'изменена'],
    ['request_sent', 'отправлена'],
    ['request_closed', 'закрыта'],
    ['request_cancelled', 'отменена'],
  ] as const)('%s -> %s', (kind, verb) => {
    const title = historyEventTitle(event({ kind, request: { supplierRequestId: 17, number: '26-0017' } }));
    expect(title).toBe(`Заявка 26-0017 ${verb}`);
  });

  it('request_created: с количеством по заказу', () => {
    const title = historyEventTitle(event({
      kind: 'request_created', quantity: 4, unit: 'sheet', request: { supplierRequestId: 17, number: '26-0017' },
    }));
    expect(title).toBe('Заявка 26-0017 создана — по заказу 4 лист');
  });
});

describe('historyDocumentLabel', () => {
  it('известные виды документов', () => {
    expect(historyDocumentLabel({ documentId: 1, docKind: 'purchase_receipt', number: '123', date: '2026-10-01' }))
      .toBe('Поступление № 123 от 01.10.2026');
    expect(historyDocumentLabel({ documentId: 2, docKind: 'bank_outflow', number: '45', date: '2026-10-02' }))
      .toBe('Списание с р/с № 45 от 02.10.2026');
    expect(historyDocumentLabel({ documentId: 3, docKind: 'cash_outflow', number: null, date: null }))
      .toBe('Выдача из кассы');
  });

  it('документ отсутствует -> null', () => {
    expect(historyDocumentLabel(null)).toBeNull();
  });

  it('неизвестный docKind выводится как есть', () => {
    expect(historyDocumentLabel({ documentId: 4, docKind: null, number: '1', date: null })).toBe('Документ № 1');
  });
});

function current(overrides: Partial<ProcurementHistoryCurrent>): ProcurementHistoryCurrent {
  return {
    name: 'МДФ 16мм', quantity: 10, unit: 'm2', purchased: false, origin: null,
    markedAt: null, quantityAtMark: null, unitAtMark: null, changedSinceMark: false, orphan: false,
    ...overrides,
  };
}

describe('currentSummaryLines', () => {
  it('нет данных -> пустой массив', () => {
    expect(currentSummaryLines(null)).toEqual([]);
  });

  it('не закуплено, потребность известна', () => {
    expect(currentSummaryLines(current({}))).toEqual(['Сейчас: потребность 10 м²', 'Не закуплено']);
  });

  it('закуплено вручную', () => {
    expect(currentSummaryLines(current({ purchased: true, origin: 'manual' })))
      .toEqual(['Сейчас: потребность 10 м²', 'Закуплено (вручную)']);
  });

  it('потребность неизвестна', () => {
    expect(currentSummaryLines(current({ quantity: null }))[0]).toBe('Сейчас: потребность нет данных');
  });

  it('предупреждение об изменившейся потребности', () => {
    const lines = currentSummaryLines(current({
      purchased: true, origin: 'manual', changedSinceMark: true, quantityAtMark: 8, unitAtMark: 'm2', quantity: 10,
    }));
    expect(lines).toEqual([
      'Сейчас: потребность 10 м²',
      'Закуплено (вручную)',
      'Потребность изменилась после отметки: было 8 м² (при отметке) → сейчас 10 м²',
    ]);
  });
});

describe('sortHistoryEventsDesc', () => {
  it('сортирует новые сверху, не мутируя исходный массив', () => {
    const older = event({ id: 'a', at: '2026-09-01T00:00:00.000Z' });
    const newer = event({ id: 'b', at: '2026-09-30T00:00:00.000Z' });
    const input = [older, newer];
    const sorted = sortHistoryEventsDesc(input);
    expect(sorted.map((item) => item.id)).toEqual(['b', 'a']);
    expect(input.map((item) => item.id)).toEqual(['a', 'b']);
  });
});

describe('historyRequestLinkLabels', () => {
  it('вложенные связи распределения: привязки группового подбора и отвязки при снятии', () => {
    const base = event({ kind: 'allocation_added', role: 'receipt' });
    expect(historyRequestLinkLabels({ ...base, requestLinks: [
      { action: 'linked', supplierRequestId: 20, number: '26-0017', quantity: 5, unit: 'sheet' },
      { action: 'unlinked', supplierRequestId: 21, number: null, quantity: null, unit: null },
    ] })).toEqual(['Приход привязан к заявке 26-0017 — 5 лист', 'Приход отвязан от заявки #21']);
    expect(historyRequestLinkLabels({ ...base, role: 'payment', requestLinks: [
      { action: 'unlinked', supplierRequestId: 20, number: '26-0017', quantity: null, unit: null },
    ] })).toEqual(['Оплата отвязана от заявки 26-0017']);
    expect(historyRequestLinkLabels(base)).toEqual([]);
  });
});
