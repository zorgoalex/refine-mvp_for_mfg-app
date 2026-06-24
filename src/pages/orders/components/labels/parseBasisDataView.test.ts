import { describe, expect, it } from 'vitest';
import { parseBasisDataView } from './parseBasisDataView';

describe('parseBasisDataView', () => {
  it('matches backend parser fixtures used by the label data inspector', () => {
    expect(parseBasisDataView(null)).toEqual({ raw: '' });
    expect(parseBasisDataView('   ')).toEqual({ raw: '' });
    expect(parseBasisDataView('12')).toEqual({ raw: '12', position: '12' });
    expect(parseBasisDataView('  7   D-01 - Боковина левая  ')).toEqual({
      raw: '7 D-01 - Боковина левая',
      position: '7',
      designation: 'D-01',
      name: 'Боковина левая',
    });
    expect(parseBasisDataView('D-02 - Полка')).toEqual({
      raw: 'D-02 - Полка',
      designation: 'D-02',
      name: 'Полка',
    });
    expect(parseBasisDataView(' поз. 15: Цоколь   передний ')).toEqual({
      raw: 'поз. 15: Цоколь передний',
      position: '15',
      name: 'Цоколь передний',
    });
    expect(parseBasisDataView('неизвестный формат без структуры')).toEqual({
      raw: 'неизвестный формат без структуры',
    });
  });
});
