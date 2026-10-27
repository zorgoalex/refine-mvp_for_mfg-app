import { describe, expect, it } from 'vitest';
import { paymentTypeTone } from './paymentTypeTone';

describe('paymentTypeTone', () => {
  it('tells cash, bank transfer and card payments apart', () => {
    expect(paymentTypeTone('нал')).toBe('cash');
    expect(paymentTypeTone('Наличные')).toBe('cash');
    expect(paymentTypeTone('Тапен ИП КаспиБанк')).toBe('card');
    expect(paymentTypeTone('Kaspi QR')).toBe('card');
    expect(paymentTypeTone('Безнал · FreedomБанк')).toBe('transfer');
    expect(paymentTypeTone('На счёт')).toBe('transfer');
  });

  it('falls back to a neutral tone', () => {
    expect(paymentTypeTone('')).toBe('other');
    expect(paymentTypeTone('Бартер')).toBe('other');
  });
});
