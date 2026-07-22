import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  normalizePageSize,
  normalizePageSizePreferences,
  pageSizeStorageKey,
  PAGE_SIZE_OPTIONS,
  usePageSizePreference,
} from './usePageSizePreference';

function PageSizeProbe() {
  const { pageSize } = usePageSizePreference('test:ssr');
  return createElement('span', null, pageSize);
}

describe('page-size preferences', () => {
  it('accepts only the bounded page sizes offered by the UI', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 20, 25, 50, 100]);
    expect(normalizePageSize(50)).toBe(50);
    expect(normalizePageSize(200)).toBeNull();
    expect(normalizePageSize('50')).toBeNull();
  });

  it('normalizes a per-list map and rejects malformed keys and values', () => {
    expect(normalizePageSizePreferences({
      'refine:orders_view': 50,
      audit: 100,
      unsupported: 200,
      stringValue: '20',
      ['x'.repeat(121)]: 20,
    })).toEqual({
      'refine:orders_view': 50,
      audit: 100,
    });
  });

  it('isolates the local fallback by user', () => {
    expect(pageSizeStorageKey('15')).toBe('erp.pageSizes.15');
    expect(pageSizeStorageKey('16')).not.toBe(pageSizeStorageKey('15'));
  });

  it('uses the fallback when rendered without browser storage', () => {
    expect(renderToString(createElement(PageSizeProbe))).toContain('10');
  });
});
