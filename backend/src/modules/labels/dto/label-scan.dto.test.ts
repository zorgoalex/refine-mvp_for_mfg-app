import { describe, expect, it } from 'vitest';
import { scanResolveSchema } from './label-scan.dto';

describe('label-scan dto', () => {
  it('accepts payload with default source', () => {
    expect(scanResolveSchema.parse({ payload: 'импорт 68|60084|1' })).toEqual({
      payload: 'импорт 68|60084|1',
      source: 'qr',
    });
  });
  it('rejects empty and oversized payloads', () => {
    expect(scanResolveSchema.safeParse({ payload: '  ' }).success).toBe(false);
    expect(scanResolveSchema.safeParse({ payload: 'x'.repeat(2001) }).success).toBe(false);
  });
  it('rejects unknown source', () => {
    expect(scanResolveSchema.safeParse({ payload: 'x', source: 'photo' }).success).toBe(false);
  });
});
