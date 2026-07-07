import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BazisXmlParseError, parseBazisXml } from './bazis-xml-parser';

const fixture = readFileSync(new URL('./__fixtures__/bazis-sample.xml', import.meta.url));

describe('parseBazisXml', () => {
  it('parses fixture with BOM and returns product header', () => {
    const parsed = parseBazisXml(fixture);
    expect(parsed.bazisVersion).toBe('2022.12.21.36090');
    expect(parsed.productName).toBe('Кухня');
    expect(parsed.productPrice).toBeCloseTo(91750.53);
  });

  it('builds tree: every parentIndex precedes child index, root is product', () => {
    const parsed = parseBazisXml(fixture);
    expect(parsed.nodes[0].nodeKind).toBe('product');
    for (const node of parsed.nodes) {
      if (node.parentIndex !== null) {
        expect(node.parentIndex).toBeLessThan(node.index);
      }
    }
  });

  it('classifies panels and hardware (counts from fixture)', () => {
    const parsed = parseBazisXml(fixture);
    const panels = parsed.nodes.filter((node) => node.objectType === 'Панель');
    const hardware = parsed.nodes.filter((node) => node.objectType === 'Фурнитура');
    expect(panels.length).toBe(5);
    expect(hardware.length).toBe(5);
    expect(parsed.summary.panels).toBe(panels.length);
    expect(parsed.summary.hardware).toBe(hardware.length);
    expect(parsed.summary.assemblies).toBe(14);
    expect(parsed.summary.totalNodes).toBe(25);
  });

  it('multiplies cumulative quantity down the tree', () => {
    const parsed = parseBazisXml(fixture);
    const doubled = parsed.nodes.find(
      (node) => node.objectType === 'Панель' && node.cumulativeQuantity === 2 && node.quantity === 1,
    );
    expect(doubled).toBeDefined();
  });

  it('reads finished-detail dimensions with fallback and Y/N boolean', () => {
    const parsed = parseBazisXml(fixture);
    const panel = parsed.nodes.find((node) => node.objectType === 'Панель');
    expect(panel?.lengthMm).toBeGreaterThan(0);
    expect(panel?.isRectangular).toBe(true);
  });

  it('keeps holes/edges/facings inside raw', () => {
    const parsed = parseBazisXml(fixture);
    const withHoles = parsed.nodes.find(
      (node) => node.objectType === 'Панель' && JSON.stringify(node.raw).includes('Отверстие'),
    );
    expect(withHoles).toBeDefined();
    expect(withHoles?.raw).not.toHaveProperty('СписокЭлементов');
  });

  it('aggregates unique materials with kind guess', () => {
    const parsed = parseBazisXml(fixture);
    expect(parsed.materials.length).toBe(5);
    const sheet = parsed.materials.find((material) => material.kindGuess === 'sheet');
    const hardware = parsed.materials.find((material) => material.kindGuess === 'hardware');
    expect(sheet).toBeDefined();
    expect(hardware).toBeDefined();
    expect(parsed.summary.uniqueMaterials).toBe(5);
  });

  it('rejects DOCTYPE (XML bomb guard)', () => {
    expect(() => parseBazisXml('<!DOCTYPE foo [<!ENTITY a "b">]><Проект/>')).toThrow(
      BazisXmlParseError,
    );
  });

  it('rejects trees above the node cap (memory guard)', () => {
    const objects = Array.from(
      { length: 20_001 },
      () => '<Объект><ТипОбъекта>Панель</ТипОбъекта></Объект>',
    ).join('');
    const xml = `<Проект Версия="1"><Изделие><Наименование>Т</Наименование><СписокЭлементов>${objects}</СписокЭлементов></Изделие></Проект>`;
    expect(() => parseBazisXml(xml)).toThrow(BazisXmlParseError);
  });

  it('rejects non-Bazis XML', () => {
    expect(() => parseBazisXml('<html></html>')).toThrow(BazisXmlParseError);
  });
});
