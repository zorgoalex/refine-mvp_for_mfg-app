import { describe, expect, it } from 'vitest';
import { summarizeOrderValidation } from '../../hooks/orderSaveValidation';
import { orderDetailSchema, orderFormSchema, requirementSchema } from '../orderSchema';

const detail = {
  detail_number: 1,
  temp_id: -1,
  height: 10,
  width: 20,
  quantity: 1,
  area: 200,
  sheet_material_type_id: 5,
  milling_type_id: 1,
  edge_type_id: 1,
  milling_cost_per_sqm: 100,
  detail_cost: 100,
};

const numericFields = [
  ['height', 'Укажите высоту детали', 'Высота должна быть больше 0'],
  ['width', 'Укажите ширину детали', 'Ширина должна быть больше 0'],
  ['quantity', 'Укажите количество деталей', 'Количество должно быть больше 0'],
  ['milling_cost_per_sqm', 'Укажите цену за кв.м.', 'Цена за кв.м. должна быть больше 0'],
  ['detail_cost', 'Сумма детали обязательна', 'Сумма детали должна быть больше 0'],
] as const;

describe.each(numericFields)('%s constructor errors', (field, message, positiveMessage) => {
  it('rejects missing and wrong-type values with the intended message and path', () => {
    for (const value of [undefined, null, '', '12', 'abc', false, {}, [], NaN, Infinity, -Infinity]) {
      const result = orderDetailSchema.safeParse({ ...detail, [field]: value });
      expect(result.success, `${field}: ${String(value)}`).toBe(false);
      if (result.success) throw new Error('Invalid numeric value accepted');
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'invalid_type', path: [field], message }),
      ]);
    }
    const { [field]: omitted, ...missing } = detail;
    expect(omitted).toBeDefined();
    const result = orderDetailSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Missing numeric value accepted');
    expect(result.error.issues[0]).toMatchObject({ path: [field], message });
  });

  it('preserves the positive constraint and its more specific message', () => {
    for (const value of [0, -1]) {
      const result = orderDetailSchema.safeParse({ ...detail, [field]: value });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Non-positive value accepted');
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'too_small', path: [field], message: positiveMessage }),
      ]);
    }
  });

  it('preserves valid numbers, defaults and quantity integer validation', () => {
    for (const value of [1, 100, 1.5]) {
      const result = orderDetailSchema.safeParse({ ...detail, [field]: value });
      if (field === 'quantity' && value === 1.5) {
        expect(result.success).toBe(false);
        if (result.success) throw new Error('Fractional quantity accepted');
        expect(result.error.issues).toEqual([
          expect.objectContaining({
            code: 'invalid_type', path: ['quantity'], message: 'Количество должно быть целым числом',
          }),
        ]);
      } else {
        expect(result).toEqual({ success: true, data: { ...detail, [field]: value, priority: 100 } });
      }
    }
  });
});

const requirement = { resource_type: 'material', required_quantity: 1, unit_id: 1, requirement_status_id: 1 };
const resourceMessage = 'Выберите тип ресурса: material, film или edge';

describe('resource type constructor errors', () => {
  it('rejects missing, wrong-type and unknown values with the intended message', () => {
    for (const value of [undefined, null, '', 'wood', 0, {}, []]) {
      const result = requirementSchema.safeParse({ ...requirement, resource_type: value });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Invalid resource type accepted');
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: 'invalid_value', path: ['resource_type'], message: resourceMessage }),
      ]);
    }
  });

  it.each(['material', 'film', 'edge'])('preserves the allowed %s resource', (resource_type) => {
    const input = { ...requirement, resource_type };
    expect(requirementSchema.safeParse(input)).toEqual({ success: true, data: input });
  });
});

it('retains every nested issue and detail highlight in the actual save-summary adapter', () => {
  const result = orderFormSchema.safeParse({
    header: { order_name: 'Тест Zod', client_id: 1, order_date: '2026-09-09', order_status_id: 1, payment_status_id: 1 },
    details: [{ ...detail, height: null, width: null, quantity: null, milling_cost_per_sqm: null, detail_cost: null }],
    requirements: [{ ...requirement, resource_type: 'wood' }],
    payments: [], workshops: [],
  });
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Invalid order accepted');
  expect(result.error.issues).toHaveLength(6);
  for (const [field, message] of numericFields) {
    expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ['details', 0, field], message }));
  }
  expect(result.error.issues).toContainEqual(expect.objectContaining({
    path: ['requirements', 0, 'resource_type'], message: resourceMessage,
  }));
  const summary = summarizeOrderValidation(result.error.issues, [detail]);
  expect(summary?.invalidDetailKeys).toEqual(['temp:-1']);
  expect(summary?.items.map(item => item.text)).toEqual([
    ...numericFields.map(([, message]) => `Позиция №1: ${message}`),
    `Материал №1: ${resourceMessage}`,
  ]);
});
