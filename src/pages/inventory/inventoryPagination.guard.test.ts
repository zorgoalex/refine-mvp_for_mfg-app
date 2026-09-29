import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

// Размер страницы в таблицах модалок склада: `pagination={{ pageSize: N }}` держит размер
// жёстко — выбор в переключателе сразу возвращается к N. Нужен defaultPageSize.
describe('inventory tables keep the chosen page size', () => {
  it('does not pin pageSize in client-side tables', () => {
    const source = readFileSync(resolve(__dirname, 'FilmInventoryPage.tsx'), 'utf8');
    expect(source).not.toMatch(/pagination=\{\{\s*pageSize:\s*\d+\s*\}\}/);
    expect(source).toContain('pagination={{ defaultPageSize: 10, showSizeChanger: true');
  });

  it('film catalog import tables use the server pagination helper with a size changer', () => {
    const source = readFileSync(resolve(__dirname, '../films/catalog-import/CatalogImportPage.tsx'), 'utf8');
    expect(source).not.toContain('pageSize: PAGE_SIZE, total');
    expect(source.match(/pagination=\{serverPagination\(/g)).toHaveLength(2);
  });
});
