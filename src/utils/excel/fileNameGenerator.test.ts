import { describe, expect, it } from 'vitest';
import { generateOrderFileName } from './fileNameGenerator';

describe('generateOrderFileName', () => {
  it('keeps the existing filename for the standard export', () => {
    expect(generateOrderFileName({
      orderId: 42,
      orderName: 'Тест 100',
      orderDate: '2026-07-30',
      clientName: 'Тест Клиент',
    })).toBe('заказ-Ф26-42-Тест-100-Тест-Клиент.xlsx');
  });

  it('adds a clear suffix for the price-free Excel export', () => {
    expect(generateOrderFileName({
      orderId: 42,
      orderName: 'Тест 100',
      orderDate: '2026-07-30',
      clientName: 'Тест Клиент',
      variant: 'without-prices',
    })).toBe('заказ-Ф26-42-Тест-100-Тест-Клиент-без-цен.xlsx');
  });
});
