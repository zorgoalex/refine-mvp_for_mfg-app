import { describe, expect, it } from 'vitest';
import { wholeOrderKeysFromComments } from './pg-cnc-telegram-repository';

describe('wholeOrderKeysFromComments', () => {
  it('keeps adjacent order numbers separated by punctuation', () => {
    expect(wholeOrderKeysFromComments(['весь заказ: 2689/2690'])).toEqual(['2689', '2690']);
  });

  it('ignores numbers outside whole-order comments and deduplicates keys', () => {
    expect(wholeOrderKeysFromComments(['деталь 2689', 'Весь заказ 2689, 2689'])).toEqual(['2689']);
  });
});
