import { describe, expect, it } from 'vitest';
import { nextSheetZoom } from './SheetPreview';

describe('nextSheetZoom', () => {
  it('steps through the zoom levels and stops at the ends', () => {
    expect(nextSheetZoom(1, 1)).toBe(1.25);
    expect(nextSheetZoom(1, -1)).toBe(0.75);
    expect(nextSheetZoom(0.5, -1)).toBe(0.5);
    expect(nextSheetZoom(3, 1)).toBe(3);
  });
});
