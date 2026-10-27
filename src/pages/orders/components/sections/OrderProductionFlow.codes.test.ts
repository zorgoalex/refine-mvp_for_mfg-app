import { describe, expect, it } from 'vitest';
import { uniqueStageCodes } from './OrderProductionFlow';

describe('uniqueStageCodes', () => {
  it('keeps one letter when the letters differ', () => {
    expect(uniqueStageCodes([
      { letter: 'Р', name: 'Распилен' },
      { letter: 'З', name: 'Закатан' },
    ])).toEqual(['Р', 'З']);
  });

  it('adds the second letter of the name when two stages share a letter', () => {
    expect(uniqueStageCodes([
      { letter: 'З', name: 'Закатан' },
      { letter: 'з', name: 'Завершено' },
      { letter: '—', name: 'Без статуса' },
    ])).toEqual(['Зк', 'Зв', '—']);
  });
});
