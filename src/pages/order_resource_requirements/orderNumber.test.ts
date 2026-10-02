import { describe, expect, it } from 'vitest';

import {
  deriveProjectCodeFromFullNumber,
  orderNumberText,
  resolveOrderNumberText,
  resolveProjectCode,
} from './orderNumber';

describe('resolveOrderNumberText', () => {
  it('использует orderName с обрезкой пробелов', () => {
    expect(resolveOrderNumberText('  2864  ', 1)).toBe('2864');
  });

  it('падает на #id, когда orderName пуст или не задан', () => {
    expect(resolveOrderNumberText('', 11)).toBe('#11');
    expect(resolveOrderNumberText('   ', 12)).toBe('#12');
    expect(resolveOrderNumberText(null, 13)).toBe('#13');
  });

  it('без orderId и orderName — пустая строка', () => {
    expect(resolveOrderNumberText(null, null)).toBe('');
    expect(resolveOrderNumberText(undefined, undefined)).toBe('');
  });
});

describe('deriveProjectCodeFromFullNumber', () => {
  it('отрезает суффикс -orderName', () => {
    expect(deriveProjectCodeFromFullNumber('МП-4923-2864', '2864')).toBe('МП-4923');
  });

  it('формат не совпал — null, а не угаданный кусок', () => {
    expect(deriveProjectCodeFromFullNumber('2864', '2864')).toBeNull();
    expect(deriveProjectCodeFromFullNumber('МП-4923-9999', '2864')).toBeNull();
  });

  it('нет fullNumber или orderName — null', () => {
    expect(deriveProjectCodeFromFullNumber(null, '2864')).toBeNull();
    expect(deriveProjectCodeFromFullNumber('МП-4923-2864', null)).toBeNull();
    expect(deriveProjectCodeFromFullNumber('МП-4923-2864', '')).toBeNull();
  });
});

describe('resolveProjectCode', () => {
  it('явное projectCode важнее производного из fullNumber', () => {
    expect(resolveProjectCode({ orderName: '2864', projectCode: 'МП-0001', fullNumber: 'МП-4923-2864' })).toBe('МП-0001');
  });

  it('пустое projectCode — выводится из fullNumber', () => {
    expect(resolveProjectCode({ orderName: '2864', projectCode: '', fullNumber: 'МП-4923-2864' })).toBe('МП-4923');
    expect(resolveProjectCode({ orderName: '2864', projectCode: null, fullNumber: 'МП-4923-2864' })).toBe('МП-4923');
  });

  it('ни projectCode, ни подходящий fullNumber — null', () => {
    expect(resolveProjectCode({ orderName: '2864' })).toBeNull();
    expect(resolveProjectCode({ orderName: '2864', fullNumber: '2864' })).toBeNull();
  });
});

describe('orderNumberText', () => {
  it('номер и код проекта через пробел', () => {
    expect(orderNumberText({ orderName: '2864', projectCode: 'МП-4923' })).toBe('2864 МП-4923');
    expect(orderNumberText({ orderName: '2864', fullNumber: 'МП-4923-2864' })).toBe('2864 МП-4923');
  });

  it('без кода проекта — только номер', () => {
    expect(orderNumberText({ orderName: '2864' })).toBe('2864');
  });

  it('без orderName — #id без кода проекта, даже если он известен', () => {
    expect(orderNumberText({ orderId: 11 })).toBe('#11');
  });
});
