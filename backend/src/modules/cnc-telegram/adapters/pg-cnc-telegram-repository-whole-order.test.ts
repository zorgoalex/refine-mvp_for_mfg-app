import { describe, expect, it } from 'vitest';
import { wholeOrderKeysFromComments, cncWholeOrderKeys, verifiedWholeOrderKeys } from './pg-cnc-telegram-repository';

describe('wholeOrderKeysFromComments', () => {
  it('keeps adjacent order numbers separated by punctuation', () => {
    expect(wholeOrderKeysFromComments(['весь заказ: 2689/2690'])).toEqual(['2689', '2690']);
  });

  it('ignores numbers outside whole-order comments and deduplicates keys', () => {
    expect(wholeOrderKeysFromComments(['деталь 2689', 'Весь заказ 2689, 2689'])).toEqual(['2689']);
  });
});

it('recognizes explicit Unicode names without mining numbers from them', () => {
  expect(wholeOrderKeysFromComments(['Кухня-1234 — весь заказ'])).toEqual([]);
  expect(cncWholeOrderKeys({ comments: ['Кухня-1234 — весь заказ'], items: [{ orderName: 'Кухня-1234' }, { orderName: '1234' }] })).toEqual(['кухня-1234']);
  expect(wholeOrderKeysFromComments(['весь заказ: 12'])).toEqual([]);
});

it('persists only verified unambiguous named identities, including short names', () => {
  const item = { orderName: 'Кухня-1234', detailNumber: 1, quantity: 1, matchOrderId: 123, matchStatus: 'matched' as const };
  expect(verifiedWholeOrderKeys({ comments: ['Кухня-1234 — весь заказ'], items: [item] })).toEqual(['кухня-1234']);
  expect(verifiedWholeOrderKeys({ comments: ['весь заказ: 12'], items: [{ ...item, orderName: '12' }] })).toEqual(['12']);
  for (const matchStatus of ['unmatched', 'needs_review'] as const) {
    expect(verifiedWholeOrderKeys({ comments: ['весь заказ'], items: [{ ...item, matchStatus }] })).toEqual([]);
  }
  expect(verifiedWholeOrderKeys({ comments: ['весь заказ'], items: [item, { ...item, matchOrderId: 456 }] })).toEqual([]);
  expect(verifiedWholeOrderKeys({ comments: ['весь заказ'], items: [{ ...item, matchOrderId: null }] })).toEqual([]);
});
