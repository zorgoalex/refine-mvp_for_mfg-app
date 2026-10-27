import { describe, expect, it } from 'vitest';
import { splitStockTabLabel } from './StockTabLabel';

describe('splitStockTabLabel', () => {
  it('splits the trailing count', () => {
    expect(splitStockTabLabel('Плёнка · 83')).toEqual({ name: 'Плёнка', count: '83' });
    expect(splitStockTabLabel('Все материалы · 1 · 7')).toEqual({ name: 'Все материалы · 1', count: '7' });
  });

  it('keeps a label without a count', () => {
    expect(splitStockTabLabel('Плёнка')).toEqual({ name: 'Плёнка', count: null });
  });
});
