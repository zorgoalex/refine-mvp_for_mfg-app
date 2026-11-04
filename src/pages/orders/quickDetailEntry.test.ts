import { describe, expect, it } from 'vitest';
import { parseQuickDetailEntry } from './quickDetailEntry';

describe('quick detail entry «716×396×2»', () => {
  it('reads height × width × quantity with any usual separator', () => {
    expect(parseQuickDetailEntry('716×396×2').rows).toEqual([{ height: 716, width: 396, quantity: 2 }]);
    expect(parseQuickDetailEntry('716x396x2').rows).toEqual([{ height: 716, width: 396, quantity: 2 }]);
    expect(parseQuickDetailEntry('716 х 396 х 2 шт').rows).toEqual([{ height: 716, width: 396, quantity: 2 }]);
    expect(parseQuickDetailEntry('716*396*2').rows).toEqual([{ height: 716, width: 396, quantity: 2 }]);
    expect(parseQuickDetailEntry('716 396 2').rows).toEqual([{ height: 716, width: 396, quantity: 2 }]);
  });

  it('quantity is optional; decimal sizes with a comma or a dot', () => {
    expect(parseQuickDetailEntry('716×396').rows).toEqual([{ height: 716, width: 396, quantity: 1 }]);
    expect(parseQuickDetailEntry('716,5x396.5').rows).toEqual([{ height: 716.5, width: 396.5, quantity: 1 }]);
  });

  it('several details by line or «;», skipping blanks', () => {
    expect(parseQuickDetailEntry('716×396×2; 500×300\n\n 1200x600x4 ').rows).toEqual([
      { height: 716, width: 396, quantity: 2 },
      { height: 500, width: 300, quantity: 1 },
      { height: 1200, width: 600, quantity: 4 },
    ]);
  });

  it('reports what it could not read and adds nothing silently in its place', () => {
    expect(parseQuickDetailEntry('716; 0x300; 500x300x0; 20000x10; abc; 500×300')).toEqual({
      rows: [{ height: 500, width: 300, quantity: 1 }],
      invalid: ['716', '0x300', '500x300x0', '20000x10', 'abc'],
    });
  });
});
