import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NEW_ORDER_STATUS_NAME,
  resolveDefaultNewOrderStatusId,
} from './orderStatusDefaults';

describe('resolveDefaultNewOrderStatusId', () => {
  it('selects Предварительный even when another active status sorts first', () => {
    expect(
      resolveDefaultNewOrderStatusId([
        { label: 'Заявка CRM', value: 9 },
        { label: DEFAULT_NEW_ORDER_STATUS_NAME, value: 1 },
      ]),
    ).toBe(1);
  });

  it('matches normalized status text', () => {
    expect(
      resolveDefaultNewOrderStatusId([
        { label: 'Заявка CRM', value: 9 },
        { label: '  ПРЕДВАРИТЕЛЬНЫЙ  ', value: 1 },
      ]),
    ).toBe(1);
  });

  it('falls back to the first numeric option when the preferred status is absent', () => {
    expect(
      resolveDefaultNewOrderStatusId([
        { label: 'Оформлен', value: 2 },
        { label: 'Запланирован', value: 3 },
      ]),
    ).toBe(2);
  });
});
