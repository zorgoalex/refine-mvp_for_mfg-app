import { describe, expect, it } from 'vitest';
import { mdfBoardOrderLink } from './OrderProductionFlow';

describe('mdfBoardOrderLink', () => {
  it('points the MDF board at the order card for today (date keeps the link through the board opening)', () => {
    const url = new URL(mdfBoardOrderLink(11842, '2026-10-28'), 'https://erp.test');
    expect(url.pathname).toBe('/mdf-work-board');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      flow: 'cnc', cardKind: 'order', cardId: '11842', date: '2026-10-28',
    });
  });
});
