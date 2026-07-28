import { describe, expect, it } from 'vitest';
import { formatWarningText } from './warningNotificationCapture';

describe('warning notification capture helpers', () => {
  it('joins warning title and description', () => {
    expect(
      formatWarningText(
        ['  Настройка   не завершена ', 'Заполните сроки этапов'],
        'fallback',
      ),
    ).toBe('Настройка не завершена: Заполните сроки этапов');
  });

  it('removes repeated parts and falls back to visible text', () => {
    expect(formatWarningText(['Внимание', 'Внимание'], null)).toBe('Внимание');
    expect(formatWarningText([], '  Данные   заказа устарели ')).toBe(
      'Данные заказа устарели',
    );
  });
});
