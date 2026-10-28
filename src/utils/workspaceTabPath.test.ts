import { describe, expect, it } from 'vitest';
import { workspaceTabPath } from './workspaceTabPath';

describe('workspaceTabPath', () => {
  it('the MDF board tab does not keep a card link, everything else of its address stays', () => {
    expect(workspaceTabPath('/mdf-work-board', '?flow=cnc&date=2026-10-20&period=1m&cardKind=bath&cardId=b-7'))
      .toBe('/mdf-work-board?flow=cnc&date=2026-10-20&period=1m');
    expect(workspaceTabPath('/mdf-work-board', '?cardKind=packet&cardId=12')).toBe('/mdf-work-board');
  });

  it('other addresses are kept as they are', () => {
    expect(workspaceTabPath('/mdf-work-board', '?flow=cnc&period=1m')).toBe('/mdf-work-board?flow=cnc&period=1m');
    expect(workspaceTabPath('/orders', '?cardId=5&sorters[0][field]=order_date'))
      .toBe('/orders?cardId=5&sorters[0][field]=order_date');
    expect(workspaceTabPath('/cut', '')).toBe('/cut');
  });
});
