import { describe, expect, it } from 'vitest';

import {
  ALLOCATION_STATE_LABELS,
  allocationStateLabel,
  allocationStateTagColor,
  canAddOnecAllocation,
  defaultPaymentAllocationAmount,
  defaultReceiptAllocationQuantity,
  formatOnecAmount,
  formatOnecQuantity,
  onecAllocationErrorMessage,
  onecAllocationErrorRequiresReload,
  onecUnitLabel,
  ONEC_DOCUMENTS_TAB_OPTIONS,
  type OnecAllocationEligibilityInput,
} from './onecDocumentsHelpers';

function baseInput(overrides: Partial<OnecAllocationEligibilityInput> = {}): OnecAllocationEligibilityInput {
  return {
    tab: 'receipts',
    posted: true,
    deletedInOnec: false,
    lineMapped: true,
    remaining: 5,
    canManage: true,
    canSeeAmounts: true,
    ...overrides,
  };
}

describe('allocation state labels', () => {
  it('labels every state', () => {
    expect(Object.keys(ALLOCATION_STATE_LABELS)).toEqual(['none', 'partial', 'full']);
    expect(allocationStateLabel('none')).toBe('не привязан');
    expect(allocationStateLabel('partial')).toBe('частично привязан');
    expect(allocationStateLabel('full')).toBe('полностью привязан');
  });

  it('colors partial and full but not none', () => {
    expect(allocationStateTagColor('none')).toBeUndefined();
    expect(allocationStateTagColor('partial')).toBe('warning');
    expect(allocationStateTagColor('full')).toBe('success');
  });
});

describe('ONEC_DOCUMENTS_TAB_OPTIONS', () => {
  it('offers receipts then payments', () => {
    expect(ONEC_DOCUMENTS_TAB_OPTIONS).toEqual([
      { value: 'receipts', label: 'Приходы' },
      { value: 'payments', label: 'Оплаты' },
    ]);
  });
});

describe('canAddOnecAllocation', () => {
  it('allows a mapped, posted, non-exhausted receipt line for a manager', () => {
    expect(canAddOnecAllocation(baseInput())).toBe(true);
    expect(canAddOnecAllocation({ ...baseInput(), lineClosed: true })).toBe(false);
  });

  it('denies without procurement.manage', () => {
    expect(canAddOnecAllocation(baseInput({ canManage: false }))).toBe(false);
  });

  it('denies an unposted or 1C-deleted document', () => {
    expect(canAddOnecAllocation(baseInput({ posted: false }))).toBe(false);
    expect(canAddOnecAllocation(baseInput({ deletedInOnec: true }))).toBe(false);
  });

  it('denies an unmapped receipt line', () => {
    expect(canAddOnecAllocation(baseInput({ lineMapped: false }))).toBe(false);
  });

  it('ignores mapping for payments', () => {
    expect(canAddOnecAllocation(baseInput({ tab: 'payments', lineMapped: false }))).toBe(true);
  });

  it('denies payments without finance.view', () => {
    expect(canAddOnecAllocation(baseInput({ tab: 'payments', canSeeAmounts: false }))).toBe(false);
  });

  it('denies when the line has nothing left to allocate', () => {
    expect(canAddOnecAllocation(baseInput({ remaining: 0 }))).toBe(false);
  });

  it('allows when remaining is unknown (unit not comparable)', () => {
    expect(canAddOnecAllocation(baseInput({ remaining: null }))).toBe(true);
  });
});

describe('defaultReceiptAllocationQuantity', () => {
  it('takes the smaller of remaining and order demand', () => {
    expect(defaultReceiptAllocationQuantity(10, 4)).toBe(4);
    expect(defaultReceiptAllocationQuantity(3, 4)).toBe(3);
  });

  it('falls back to whichever value is available', () => {
    expect(defaultReceiptAllocationQuantity(null, 4)).toBe(4);
    expect(defaultReceiptAllocationQuantity(10, null)).toBe(10);
  });

  it('returns undefined when both are unknown or non-positive', () => {
    expect(defaultReceiptAllocationQuantity(null, null)).toBeUndefined();
    expect(defaultReceiptAllocationQuantity(0, 0)).toBeUndefined();
  });
});

describe('defaultPaymentAllocationAmount', () => {
  it('uses the full remaining amount when known and positive', () => {
    expect(defaultPaymentAllocationAmount(150)).toBe(150);
  });

  it('returns undefined when unknown or exhausted', () => {
    expect(defaultPaymentAllocationAmount(null)).toBeUndefined();
    expect(defaultPaymentAllocationAmount(0)).toBeUndefined();
  });
});

describe('onecUnitLabel', () => {
  it('prefers the normalized unit code', () => {
    expect(onecUnitLabel('m2', 'м2')).toBe('м²');
    expect(onecUnitLabel('sheet', null)).toBe('лист');
    expect(onecUnitLabel('pcs', null)).toBe('шт');
    expect(onecUnitLabel('set', null)).toBe('компл.');
    expect(onecUnitLabel('lm', null)).toBe('пог. м');
  });

  it('falls back to the raw 1C unit name when the code is unknown', () => {
    expect(onecUnitLabel(null, 'упаковка')).toBe('упаковка');
    expect(onecUnitLabel(null, null)).toBe('');
  });
});

describe('formatOnecQuantity', () => {
  it('formats the value with its unit label', () => {
    expect(formatOnecQuantity(12.4, 'm2', null)).toBe('12,4 м²');
    expect(formatOnecQuantity(10, 'pcs', null)).toBe('10 шт');
  });

  it('omits the unit suffix when no label is available', () => {
    expect(formatOnecQuantity(5, null, null)).toBe('5');
  });
});

describe('formatOnecAmount', () => {
  it('formats a visible amount with the ruble sign', () => {
    expect(formatOnecAmount(1234.5, 'RUB')).toBe('1 234,50 ₽');
    expect(formatOnecAmount(1234.5, 'KZT')).toBe('1 234,50 ₸');
    expect(formatOnecAmount(10, 'CNY').endsWith(' CNY')).toBe(true);
  });

  it('shows a dash for a hidden or missing amount', () => {
    expect(formatOnecAmount(null, 'KZT')).toBe('—');
  });
});

describe('onecAllocationErrorMessage', () => {
  it('prefers the known Russian message for a recognized error code', () => {
    expect(onecAllocationErrorMessage({ code: 'ONEC_LINE_NOT_MAPPED', message: 'raw' })).toBe(
      'Строка документа не сопоставлена с материалом ERP',
    );
    expect(onecAllocationErrorMessage({ code: 'PROCUREMENT_LOCKED_BY_ONEC' })).toBe(
      'Материал уже оприходован документом 1С',
    );
  });

  it('falls back to the server message for an unrecognized code', () => {
    expect(onecAllocationErrorMessage({ code: 'SOME_OTHER_CODE', message: 'server said so' })).toBe('server said so');
  });

  it('falls back to a generic message when nothing is known', () => {
    expect(onecAllocationErrorMessage(undefined)).toBe('Не удалось выполнить операцию');
    expect(onecAllocationErrorMessage({})).toBe('Не удалось выполнить операцию');
  });

  it('ф.3б: коды связи приходов с заявками поставщикам тоже сопоставлены', () => {
    expect(onecAllocationErrorMessage({ code: 'SUPPLIER_REQUEST_NOT_SENT' })).toBe('Привязать приход можно только к отправленной заявке');
    expect(onecAllocationErrorMessage({ code: 'SUPPLIER_REQUEST_LINK_EXCEEDS_REQUEST' })).toBe('Больше, чем заказано в заявке');
    expect(onecAllocationErrorMessage({ code: 'SUPPLIER_REQUESTS_DISABLED' })).toBe('Заявки поставщикам пока выключены');
  });
});

describe('onecAllocationErrorRequiresReload', () => {
  it('flags state-changing conflicts', () => {
    expect(onecAllocationErrorRequiresReload('PROCUREMENT_VERSION_CONFLICT')).toBe(true);
    expect(onecAllocationErrorRequiresReload('ONEC_ALLOCATION_EXISTS')).toBe(true);
  });

  it('does not flag plain validation errors', () => {
    expect(onecAllocationErrorRequiresReload('ONEC_ALLOCATION_MEASURE_INVALID')).toBe(false);
    expect(onecAllocationErrorRequiresReload(undefined)).toBe(false);
  });
});

describe('модалка распределения: карточка только выбранного заказа (R2)', () => {
  it('isOrderCardCurrent: чужой заказ, загрузка или пустая карточка запрещают отправку', async () => {
    const { isOrderCardCurrent } = await import('./onecDocumentsHelpers');
    expect(isOrderCardCurrent(12, false, 12)).toBe(true);
    expect(isOrderCardCurrent(11, false, 12)).toBe(false);
    expect(isOrderCardCurrent(12, true, 12)).toBe(false);
    expect(isOrderCardCurrent(null, false, 12)).toBe(false);
    expect(isOrderCardCurrent(12, false, undefined)).toBe(false);
  });

  it('поздний ответ по прежнему заказу игнорируется', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./AllocationModal.tsx', import.meta.url), 'utf8');
    expect(source).toContain('if (cardRequestRef.current !== requestId || response.data.orderId !== orderId) return;');
    expect(source).toContain('cardReady && resourceKey != null');
    // Отправка A → выбор B → ошибка A: заказ нельзя сменить во время отправки, а повторная
    // загрузка после ошибки идёт только для всё ещё выбранного заказа.
    expect(source).toContain('disabled={submitting}');
    expect(source).toContain('selectedOrderRef.current === selectedOrderId) void loadOrderCard(selectedOrderId);');
  });
});
