import { describe, expect, it } from 'vitest';
import { parseBasisData } from './parse-basis-data';

describe('parseBasisData', () => {
  it('returns an empty raw value for null and blank input', () => {
    expect(parseBasisData(null)).toEqual({ raw: '' });
    expect(parseBasisData('   ')).toEqual({ raw: '' });
  });

  it('parses a position-only value', () => {
    expect(parseBasisData('12')).toEqual({ raw: '12', position: '12' });
  });

  it('parses a leading position with designation and name', () => {
    expect(parseBasisData('  7   D-01 - Боковина левая  ')).toEqual({
      raw: '7 D-01 - Боковина левая',
      position: '7',
      designation: 'D-01',
      name: 'Боковина левая',
    });
  });

  it('parses designation and name without a position', () => {
    expect(parseBasisData('D-02 - Полка')).toEqual({
      raw: 'D-02 - Полка',
      designation: 'D-02',
      name: 'Полка',
    });
  });

  it('parses noisy colon-separated position text', () => {
    expect(parseBasisData(' поз. 15: Цоколь   передний ')).toEqual({
      raw: 'поз. 15: Цоколь передний',
      position: '15',
      name: 'Цоколь передний',
    });
  });

  it('parses Bazis slash grammar and preserves slashes inside the name', () => {
    expect(parseBasisData('7/D-01/Фасад/левая створка')).toEqual({
      raw: '7/D-01/Фасад/левая створка',
      position: '7',
      designation: 'D-01',
      name: 'Фасад/левая створка',
    });
  });

  it('preserves unknown text without throwing', () => {
    expect(parseBasisData('неизвестный формат без структуры')).toEqual({
      raw: 'неизвестный формат без структуры',
    });
  });
});
