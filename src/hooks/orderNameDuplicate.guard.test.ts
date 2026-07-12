import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Жёсткий блок дублей номера заказа (409 ORDER_NAME_DUPLICATE, решение
 * пользователя 2026-07-12: обхода «сохранить всё равно» НЕТ).
 * Node-env без jsdom — UI-обработка фиксируется source-text guard'ами.
 */
const useOrderSave = readFileSync(new URL('./useOrderSave.ts', import.meta.url), 'utf8');
const bazisModal = readFileSync(
  new URL('../pages/bazis/CreateOrderModal.tsx', import.meta.url),
  'utf8',
);

describe('order-name duplicate handling guards', () => {
  it('order form save offers the suggested number and has NO save-anyway path', () => {
    expect(useOrderSave).toContain("isApiError(err, 'ORDER_NAME_DUPLICATE')");
    expect(useOrderSave).toContain('suggestedOrderName');
    expect(useOrderSave).toMatch(/onOk: \(\) => void saveOrder\(\{ \.\.\.values, order_name: suggested \}/);
    expect(useOrderSave).not.toMatch(/allowDuplicate/i);
  });

  it('bazis create-order modal substitutes the suggested number and mints a fresh idempotency key', () => {
    expect(bazisModal).toContain("error.code === 'ORDER_NAME_DUPLICATE'");
    expect(bazisModal).toContain('form.setFieldsValue({ orderName: suggested })');
    expect(bazisModal).toMatch(/ORDER_NAME_DUPLICATE'[\s\S]*?setIdempotencyKey\(createUuid\(\)\)/);
  });
});
