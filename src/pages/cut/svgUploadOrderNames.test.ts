import { describe, expect, it } from 'vitest';
import { missingSvgOrdersWarning, svgFileNameOnlyOrderNames, svgUploadOrderNames } from './svgUploadOrderNames';

describe('SVG upload source order scope', () => {
  it('includes order2900 from numeric source pieces even when the filename omits it', () => {
    expect(svgUploadOrderNames([
      { orderName: '2900', detailNumber: 3 },
      { orderName: '2895', detailNumber: 1 },
      { orderName: '2900', detailNumber: 3 },
      { orderName: 'visual only', detailNumber: null },
    ], ['2895', '2887'])).toEqual(['2900', '2895', '2887']);
  });
  it('keeps unknown source names for explicit lookup warnings, without inventing an ID', () => {
    expect(svgUploadOrderNames([{ orderName: ' E2E-missing ', detailNumber: 3 }], [])).toEqual(['E2E-missing']);
  });
  it('names every missing order in quotes and marks the ones read only from the file name', () => {
    const fileNameOnly = svgFileNameOnlyOrderNames([{ orderName: 'К51', detailNumber: 3 }], ['зак3160', 'К51']);
    expect(fileNameOnly).toEqual(['зак3160']);
    expect(missingSvgOrdersWarning(['зак3160'], fileNameOnly))
      .toBe('Не найден заказ «зак3160» из SVG (из имени файла: «зак3160»)');
    expect(missingSvgOrdersWarning(['зак3160', 'К51'], fileNameOnly))
      .toBe('Не найдены заказы «зак3160», «К51» из SVG (из имени файла: «зак3160»)');
    expect(missingSvgOrdersWarning(['К51'], fileNameOnly)).toBe('Не найден заказ «К51» из SVG');
  });
});

