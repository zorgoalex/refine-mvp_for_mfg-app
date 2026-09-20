import { describe, expect, it } from 'vitest';
import { nameRule } from './nameRules';

describe('form name rules', () => {
  it('preserves Unicode and validates actual reference limits', async () => {
    await expect(nameRule('order_status_name').validator(null, 'Тест Әлия')).resolves.toBeUndefined();
    await expect(nameRule('order_status_name').validator(null, 'Я'.repeat(51))).rejects.toThrow('50');
    await expect(nameRule('client_name').validator(null, 'Я')).rejects.toThrow('2');
    await expect(nameRule('username').validator(null, 'ЯЯ')).rejects.toThrow('3');
    await expect(nameRule('order_name').validator(null, '1')).resolves.toBeUndefined();
    await expect(nameRule('material_name').validator(null, 'Тест\0')).rejects.toThrow('управляющие');
  });
});
