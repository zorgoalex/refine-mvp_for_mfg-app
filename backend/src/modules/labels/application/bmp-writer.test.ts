import { describe, expect, it } from 'vitest';
import { createWhiteBitmap, writeBmp } from './bmp-writer';

describe('bmp writer', () => {
  it('writes a Windows BMP header with dimensions', () => {
    const bmp = writeBmp(createWhiteBitmap(684, 709));

    expect(bmp.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(bmp.readInt32LE(18)).toBe(684);
    expect(bmp.readInt32LE(22)).toBe(709);
  });
});
