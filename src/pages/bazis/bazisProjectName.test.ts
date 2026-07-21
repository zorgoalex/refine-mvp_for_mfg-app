import { describe, expect, it } from 'vitest';
import { suggestBazisProjectName } from './bazisProjectName';

describe('suggestBazisProjectName', () => {
  it('prefers Bazis order name over joined product names', () => {
    expect(suggestBazisProjectName(' 1485 ', 'Гордеробная + кухня.xml')).toBe('1485');
  });

  it('falls back to XML filename without extension', () => {
    expect(suggestBazisProjectName(null, 'Заказ 1485.XML')).toBe('Заказ 1485');
  });
});
