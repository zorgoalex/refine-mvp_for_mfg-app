import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The table wrapper is unrelated to the display contract. Keep the real
// ReferenceSortOrderShow, Refine TextField and AntD Typography under test.
vi.mock('../ui/tooltipDelay', () => ({ Table: { Column: () => null } }));
import { ReferenceSortOrderShow } from './ReferenceSortOrder';

describe('reference sort order display', () => {
  it.each([-32768, -1, 0, 100, 32767, '0', '0010', '', null, undefined])(
    'preserves the literal value %s without normalization', value => {
      const html = renderToStaticMarkup(<ReferenceSortOrderShow value={value} />);
      expect(html.replace(/<[^>]*>/g, '')).toBe(`Порядок сортировки${value ?? ''}`);
      expect(html).toContain('<h5');
    },
  );
});
