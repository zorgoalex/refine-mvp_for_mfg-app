import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReferenceHeaderCell } from './tooltipDelay';

describe('reference tables: column headers', () => {
  it('wraps a plain title into the two-line clamp and keeps the full text as a hint', () => {
    expect(renderToStaticMarkup(<table><thead><tr><ReferenceHeaderCell className="ant-table-cell">Категория номенклатуры</ReferenceHeaderCell></tr></thead></table>))
      .toContain('<th class="ant-table-cell" title="Категория номенклатуры"><span class="reference-table__title">Категория номенклатуры</span></th>');
  });
  it('leaves sorter/filter content and empty cells as they are', () => {
    const sorter = renderToStaticMarkup(<table><thead><tr><ReferenceHeaderCell><div className="ant-table-column-sorters">Название</div></ReferenceHeaderCell></tr></thead></table>);
    expect(sorter).toContain('<th><div class="ant-table-column-sorters">Название</div></th>');
    expect(renderToStaticMarkup(<table><thead><tr><ReferenceHeaderCell /></tr></thead></table>)).toContain('<th></th>');
  });
  it('is switched on for every list of the reference wrapper and styled once', () => {
    const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(read('../components/LocalizedList.tsx')).toContain('<ReferenceTableContext.Provider value={true}>');
    expect(read('./tooltipDelay.tsx')).toContain("header: { cell: ReferenceHeaderCell, ...rest.components?.header }");
    const css = read('../styles/app.css');
    expect(css).toContain('.reference-table .ant-table-thead .ant-table-column-title {');
    expect(css).toContain('-webkit-line-clamp: 2;');
  });
});
