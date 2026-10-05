import { describe, expect, it } from 'vitest';
import { categoryDisplay } from './categoryDisplay';

describe('film category display', () => {
  it('shows all-caps 1C categories in normal case and keeps abbreviations', () => {
    expect(categoryDisplay('ПЛЕНКА ПВХ ДЛЯ МДФ')).toBe('Пленка ПВХ для МДФ');
    expect(categoryDisplay('КРОМКА ПВХ')).toBe('Кромка ПВХ');
    expect(categoryDisplay('СТОЛЕШНИЦЫ')).toBe('Столешницы');
    expect(categoryDisplay('МДФ 2800Х2070')).toBe('МДФ 2800Х2070');
  });

  it('leaves abbreviations, mixed case and empty values as they are', () => {
    expect(categoryDisplay('ЛДСП')).toBe('ЛДСП');
    expect(categoryDisplay('HPL')).toBe('HPL');
    expect(categoryDisplay('Сырье для МДФ произ-ва')).toBe('Сырье для МДФ произ-ва');
    expect(categoryDisplay('мебель')).toBe('мебель');
    expect(categoryDisplay(null)).toBe('');
    expect(categoryDisplay('  ')).toBe('');
  });
});
