import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * DOMParser недоступен в node-тест-окружении (без jsdom), поэтому
 * multi-изделие поведение parseXmlPreview фиксируем source-text guard'ами
 * (паттерн репо для DOM-связанного FE-кода).
 *
 * Контракт (зеркало backend bazis-xml-parser):
 * - Проект может содержать НЕСКОЛЬКО <Изделие> — каждое отдельный root дерева.
 * - productName = имена изделий через « + ».
 */
const source = readFileSync(new URL('./parseXmlPreview.ts', import.meta.url), 'utf8');

describe('parseXmlPreview multi-product guards', () => {
  it('iterates ALL Изделие children, not only the first', () => {
    expect(source).toContain("directChildren(project, 'Изделие')");
    expect(source).not.toContain("childByTag(project, 'Изделие')");
  });

  it('builds one tree root per product', () => {
    expect(source).toMatch(/products\.map\(.*?walk\(/s);
  });

  it('joins product names with " + " for the preview header', () => {
    expect(source).toContain("join(' + ')");
  });
});
