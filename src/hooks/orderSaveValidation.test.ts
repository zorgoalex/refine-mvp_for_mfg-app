import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  orderValidationDetailKey,
  summarizeOrderValidation,
} from './orderSaveValidation';

const details = [
  { detail_number: 4, temp_id: 101 },
  { detail_number: 18, detail_id: 202 },
  { detail_number: 31, temp_id: 303 },
];

describe('order save validation presentation', () => {
  it('turns backend detail indexes into visible position numbers and row keys', () => {
    const summary = summarizeOrderValidation({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'Order payload validation failed',
      details: {
        errors: [
          { field: 'details[0].height', message: 'Размер детали (2884×625) превышает лист (2800×2070)' },
          { field: 'details[1].height', message: 'Размер детали (2904×625) превышает лист (2800×2070)' },
          { field: 'details[2].height', message: 'Размер детали (2899×350) превышает лист (2800×2070)' },
        ],
      },
    }, details);

    expect(summary?.items.map((item) => item.text)).toEqual([
      'Позиция №4: Размер детали (2884×625) превышает лист (2800×2070)',
      'Позиция №18: Размер детали (2904×625) превышает лист (2800×2070)',
      'Позиция №31: Размер детали (2899×350) превышает лист (2800×2070)',
    ]);
    expect(summary?.invalidDetailKeys).toEqual(['temp:101', 'id:202', 'temp:303']);
  });

  it('humanizes every order section instead of exposing backend paths or English validators', () => {
    const summary = summarizeOrderValidation({
      code: 'VALIDATION_ERROR',
      status: 422,
      message: 'Order payload validation failed',
      details: {
        errors: [
          { field: 'header.orderName', message: 'orderName is required' },
          { field: 'details[0].sheetMaterialTypeId', message: 'details[0].sheetMaterialTypeId must be a positive integer' },
          { field: 'payments[0].amount', message: 'payments[0].amount must be greater than zero' },
          { field: 'workshops[0].workshopId', message: 'workshops[0].workshopId must be a positive integer' },
          { field: 'requirements[0].resourceType', message: 'unsupported resource type' },
          { field: 'dowelingLinks[0].dowelingOrderId', message: 'dowelingOrderId must be unique' },
        ],
      },
    }, details);

    expect(summary?.items.map((item) => item.text)).toEqual([
      'Основная информация — Название заказа: заполните обязательное поле',
      'Позиция №4 — Листовой материал: укажите корректное значение',
      'Платёж №1 — Сумма платежа: значение должно быть больше нуля',
      'Производство №1 — Цех: укажите корректное значение',
      'Материал №1 — Тип ресурса: выбран неподдерживаемый тип ресурса',
      'Присадка №1 — Задание на присадку: одно задание добавлено несколько раз',
    ]);
  });

  it('accepts Zod issue paths and preserves their readable Russian messages', () => {
    const summary = summarizeOrderValidation([
      { path: ['details', 1, 'width'], message: 'Ширина должна быть положительной' },
      { path: ['details'], message: 'Необходимо добавить минимум одну позицию (деталь)' },
    ], details);

    expect(summary?.items.map((item) => item.text)).toEqual([
      'Позиция №18: Ширина должна быть положительной',
      'Позиции заказа: Необходимо добавить минимум одну позицию (деталь)',
    ]);
    expect(summary?.invalidDetailKeys).toEqual(['id:202']);
  });

  it('uses a readable 422 message when no structured error list is available', () => {
    expect(summarizeOrderValidation({
      code: 'PROJECT_CLIENT_MISMATCH',
      status: 422,
      message: 'Клиент заказа не совпадает с клиентом проекта',
    }, details)?.items[0].text).toBe('Клиент заказа не совпадает с клиентом проекта');
  });

  it('returns null for non-validation failures', () => {
    expect(summarizeOrderValidation(new Error('network down'), details)).toBeNull();
  });

  it('builds stable keys for saved and unsaved detail rows', () => {
    expect(orderValidationDetailKey({ detail_id: 9, detail_number: 1 })).toBe('id:9');
    expect(orderValidationDetailKey({ temp_id: 7, detail_number: 2 })).toBe('temp:7');
    expect(orderValidationDetailKey({ detail_number: 3 })).toBe('number:3');
  });

  it('wires validation state to the order detail table and marks invalid rows', () => {
    const orderFormSource = readFileSync(
      new URL('../pages/orders/components/OrderForm.tsx', import.meta.url),
      'utf8',
    );
    const tableSource = readFileSync(
      new URL('../pages/orders/components/tables/OrderDetailTable.tsx', import.meta.url),
      'utf8',
    );

    expect(orderFormSource).toContain('<OrderSaveValidationContext.Provider value={saveValidation}>');
    expect(orderFormSource).toContain("setActiveTab('details')");
    expect(tableSource).toContain('isValidationInvalid(record)');
    expect(tableSource).toContain("'aria-invalid': isValidationError || undefined");
    expect(tableSource).toContain("outline: isValidationError ? '2px solid #ff4d4f'");
    expect(tableSource).toContain('pageContainingOrderDetail(paginatedDetails, firstInvalidDetail, pageSize)');
  });

  it('clears static Ant Design notifications through the supported API', () => {
    const saveHookSource = readFileSync(new URL('./useOrderSave.ts', import.meta.url), 'utf8');

    expect(saveHookSource).toContain('notification.destroy(validationNotificationKey)');
    expect(saveHookSource).not.toContain('notification.close(');
  });
});
