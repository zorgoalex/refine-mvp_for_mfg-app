import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order show detail column widths', () => {
  it.each([
    ['height', 54],
    ['width', 54],
    ['quantity', 47.25],
    ['area', 54],
  ])('keeps %s 25%% narrower', (key, width) => {
    expect(source).toMatch(
      new RegExp(`key: '${key}',\\s+width: ${width},`),
    );
  });
});
