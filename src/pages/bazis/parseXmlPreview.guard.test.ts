import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { swapImportedBazisPanelDimensions } from './parseXmlPreview';

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

describe('parseXmlPreview panel dimensions', () => {
  it('shows imported panel width as ERP height and imported height as ERP width', () => {
    expect(swapImportedBazisPanelDimensions(580, 452)).toEqual({
      heightMm: 452,
      widthMm: 580,
    });
  });

  it('rounds preview dimensions down below .5 and up from .5', () => {
    expect(swapImportedBazisPanelDimensions(580.49, 452.49)).toEqual({
      heightMm: 452,
      widthMm: 580,
    });
    expect(swapImportedBazisPanelDimensions(580.5, 452.5)).toEqual({
      heightMm: 453,
      widthMm: 581,
    });
  });

  it('uses the swapped dimensions in panel preview titles', () => {
    expect(source).toContain(
      'swapImportedBazisPanelDimensions(sourceHeight, sourceWidth)',
    );
  });
});
