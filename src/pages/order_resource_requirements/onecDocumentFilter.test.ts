import { describe, expect, it } from 'vitest';

import {
  ONEC_DOCUMENT_FILTER_MAX,
  buildOnecDocumentFilterOptionGroups,
  onecDocumentFilterFallbackLabel,
  onecDocumentFilterOptionLabel,
  onecDocumentFilterTagText,
  onecDocumentFilterTruncatedHint,
  parseOnecDocumentIdParam,
  type OnecDocumentFilterDoc,
} from './onecDocumentFilter';

describe('parseOnecDocumentIdParam', () => {
  it('принимает положительное целое в виде строки', () => {
    expect(parseOnecDocumentIdParam('1')).toBe(1);
    expect(parseOnecDocumentIdParam('42')).toBe(42);
    expect(parseOnecDocumentIdParam('1000000')).toBe(1000000);
  });

  it('отклоняет всё, что не является положительным целым', () => {
    expect(parseOnecDocumentIdParam(null)).toBeNull();
    expect(parseOnecDocumentIdParam(undefined)).toBeNull();
    expect(parseOnecDocumentIdParam('')).toBeNull();
    expect(parseOnecDocumentIdParam('0')).toBeNull();
    expect(parseOnecDocumentIdParam('-5')).toBeNull();
    expect(parseOnecDocumentIdParam('5.5')).toBeNull();
    expect(parseOnecDocumentIdParam('5abc')).toBeNull();
    expect(parseOnecDocumentIdParam('abc')).toBeNull();
    expect(parseOnecDocumentIdParam(' 5')).toBeNull();
    expect(parseOnecDocumentIdParam('01')).toBeNull();
  });
});

describe('onecDocumentFilterOptionLabel', () => {
  it('строит подпись прихода без числа заказов', () => {
    expect(onecDocumentFilterOptionLabel({ kind: 'purchase_receipt', number: 'E2E-1', date: '2026-09-28' }))
      .toBe('Поступление №E2E-1 от 28.09.2026');
  });

  it('добавляет число заказов, когда оно посчитано', () => {
    expect(onecDocumentFilterOptionLabel({ kind: 'purchase_receipt', number: 'E2E-1', date: '2026-09-28', ordersCount: 1 }))
      .toBe('Поступление №E2E-1 от 28.09.2026 · 1 заказ');
    expect(onecDocumentFilterOptionLabel({ kind: 'purchase_receipt', number: 'E2E-1', date: '2026-09-28', ordersCount: 3 }))
      .toBe('Поступление №E2E-1 от 28.09.2026 · 3 заказа');
  });

  it('различает РКО и списание со счёта', () => {
    expect(onecDocumentFilterOptionLabel({ kind: 'cash_outflow', number: 'РКО-9', date: '2026-09-28', ordersCount: 2 }))
      .toBe('РКО №РКО-9 от 28.09.2026 · 2 заказа');
    expect(onecDocumentFilterOptionLabel({ kind: 'bank_outflow', number: '77', date: '2026-09-01' }))
      .toBe('Списание №77 от 01.09.2026');
  });
});

describe('onecDocumentFilterFallbackLabel / onecDocumentFilterTagText', () => {
  it('строит заглушку по id, когда карточка документа не загрузилась', () => {
    expect(onecDocumentFilterFallbackLabel(777)).toBe('Документ #777');
  });

  it('строит текст закрываемого тега', () => {
    expect(onecDocumentFilterTagText('Поступление №E2E-1 от 28.09.2026')).toBe(
      'Только заказы документа 1С: Поступление №E2E-1 от 28.09.2026',
    );
  });
});

describe('buildOnecDocumentFilterOptionGroups', () => {
  const receipt: OnecDocumentFilterDoc = { documentId: 1, kind: 'purchase_receipt', number: 'E2E-1', date: '2026-09-28', ordersCount: 2 };
  const cashOutflow: OnecDocumentFilterDoc = { documentId: 2, kind: 'cash_outflow', number: 'РКО-1', date: '2026-09-27', ordersCount: 1 };
  const bankOutflow: OnecDocumentFilterDoc = { documentId: 3, kind: 'bank_outflow', number: '5', date: '2026-09-20', ordersCount: 1 };

  it('группирует приходы и оплаты отдельно', () => {
    const groups = buildOnecDocumentFilterOptionGroups([receipt, cashOutflow, bankOutflow]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ label: 'Приходы', options: [{ value: 1, label: 'Поступление №E2E-1 от 28.09.2026 · 2 заказа' }] });
    expect(groups[1]).toEqual({
      label: 'Оплаты',
      options: [
        { value: 2, label: 'РКО №РКО-1 от 27.09.2026 · 1 заказ' },
        { value: 3, label: 'Списание №5 от 20.09.2026 · 1 заказ' },
      ],
    });
  });

  it('не добавляет пустую группу', () => {
    expect(buildOnecDocumentFilterOptionGroups([receipt])).toEqual([
      { label: 'Приходы', options: [{ value: 1, label: 'Поступление №E2E-1 от 28.09.2026 · 2 заказа' }] },
    ]);
    expect(buildOnecDocumentFilterOptionGroups([cashOutflow])).toEqual([
      { label: 'Оплаты', options: [{ value: 2, label: 'РКО №РКО-1 от 27.09.2026 · 1 заказ' }] },
    ]);
  });

  it('пустой список документов — пустой массив групп', () => {
    expect(buildOnecDocumentFilterOptionGroups([])).toEqual([]);
  });
});

describe('onecDocumentFilterTruncatedHint', () => {
  it('возвращает подсказку с лимитом, когда список обрезан', () => {
    expect(onecDocumentFilterTruncatedHint(true)).toBe(`Показаны первые ${ONEC_DOCUMENT_FILTER_MAX} документов.`);
  });

  it('возвращает null, когда список не обрезан', () => {
    expect(onecDocumentFilterTruncatedHint(false)).toBeNull();
  });
});
