import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * DOMParser недоступен в node-тест-окружении (без jsdom), поэтому
 * multi-изделие поведение parseXmlPreview фиксируем source-text guard'ами
 * (паттерн репо для DOM-связанного FE-кода).
 *
 * Контракт (зеркало backend bazis-xml-parser):
 * - Проект может содержать НЕСКОЛЬКО <Изделие> — каждое отдельный root дерева.
 * - productName = имена изделий через « + » только для состава ревизии.
 * - bazisOrderNo = имя/номер Базис-заказа для названия проекта.
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

  it('reads Bazis project name from the order attribute, with product order fallback', () => {
    expect(source).toContain("project.getAttribute('Наименование')");
    expect(source).toContain("textOfChild(product, 'Заказ')");
    expect(source).toContain('bazisOrderNo: projectOrderName ?? firstProductOrderNo');
  });
});
