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

  it('reads raw bazis order number from project attribute and product order from root product only', () => {
    const parsed = parseBazisXml(fixture);
    expect(parsed.bazisOrderNo).toBeNull();
    expect(parsed.nodes[0]?.nodeKind).toBe('product');
    expect(parsed.nodes[0]?.productOrderNo).toBeNull();
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

  it('keeps productOrderNo null for non-root nodes', () => {
    const parsed = parseBazisXml(fixture);
    for (const node of parsed.nodes.filter((candidate) => candidate.parentIndex !== null)) {
      expect(node.productOrderNo).toBeNull();
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

  it('keeps same material name separate per source context (sheet vs film vs edge)', () => {
    const xml = `<Проект Версия="1"><Изделие><Наименование>Т</Наименование><Цена>1</Цена><СписокЭлементов>
      <Объект><ТипОбъекта>Панель</ТипОбъекта><Наименование>П1</Наименование>
        <ОсновнойМатериал><Наименование>Белый</Наименование></ОсновнойМатериал>
        <ОблицовкаПласти1><Пласть><Наименование>Белый</Наименование></Пласть></ОблицовкаПласти1>
        <СписокКромок1><Кромка><Наименование>Белый</Наименование></Кромка></СписокКромок1>
      </Объект>
    </СписокЭлементов></Изделие></Проект>`;
    const parsed = parseBazisXml(xml);
    const named = parsed.materials.filter((material) => material.name === 'Белый');
    expect(named).toHaveLength(3);
    expect(new Set(named.map((material) => material.kindGuess))).toEqual(
      new Set(['sheet', 'film', 'edge']),
    );
  });

  describe('multi-product project (несколько Изделие в Проект)', () => {
    const multiXml = `<Проект Наименование=" 1471 " Версия="1">
      <Изделие><Наименование>санузел</Наименование><Заказ> 1471 </Заказ><Цена>100.5</Цена><Количество>1</Количество><СписокЭлементов>
        <Объект><ТипОбъекта>Панель</ТипОбъекта><Наименование>П1</Наименование>
          <ОсновнойМатериал><Наименование>ЛДСП белый</Наименование></ОсновнойМатериал>
        </Объект>
      </СписокЭлементов></Изделие>
      <Изделие><Наименование>шкаф</Наименование><Заказ> </Заказ><Цена>200</Цена><Количество>1</Количество><СписокЭлементов>
        <Сборка><Наименование>Секция</Наименование><Количество>2</Количество><СписокЭлементов>
          <Объект><ТипОбъекта>Панель</ТипОбъекта><Наименование>П2</Наименование><Количество>1</Количество>
            <ОсновнойМатериал><Наименование>МДФ 16</Наименование></ОсновнойМатериал>
          </Объект>
        </СписокЭлементов></Сборка>
      </СписокЭлементов></Изделие>
    </Проект>`;

    it('creates one root node per product', () => {
      const parsed = parseBazisXml(multiXml);
      const roots = parsed.nodes.filter((node) => node.parentIndex === null);
      expect(roots).toHaveLength(2);
      expect(roots.map((node) => node.nodeKind)).toEqual(['product', 'product']);
      expect(roots.map((node) => node.name)).toEqual(['санузел', 'шкаф']);
      expect(roots.map((node) => node.seq)).toEqual([0, 1]);
    });

    it('walks children of every product, not only the first', () => {
      const parsed = parseBazisXml(multiXml);
      const panels = parsed.nodes.filter((node) => node.objectType === 'Панель');
      expect(panels.map((node) => node.name)).toEqual(['П1', 'П2']);
      const secondRoot = parsed.nodes.find((node) => node.name === 'шкаф');
      const assembly = parsed.nodes.find((node) => node.name === 'Секция');
      expect(assembly?.parentIndex).toBe(secondRoot?.index);
      const nested = parsed.nodes.find((node) => node.name === 'П2');
      expect(nested?.parentIndex).toBe(assembly?.index);
      expect(nested?.cumulativeQuantity).toBe(2);
      expect(parsed.summary.totalNodes).toBe(5);
      expect(parsed.summary.panels).toBe(2);
      expect(parsed.summary.assemblies).toBe(1);
    });

    it('joins product names and sums prices in revision header', () => {
      const parsed = parseBazisXml(multiXml);
      expect(parsed.bazisOrderNo).toBe('1471');
      expect(parsed.productName).toBe('санузел + шкаф');
      expect(parsed.productPrice).toBeCloseTo(300.5);
    });

    it('reads product order number only on root product nodes', () => {
      const parsed = parseBazisXml(multiXml);
      const roots = parsed.nodes.filter((node) => node.parentIndex === null);
      expect(roots.map((node) => node.productOrderNo)).toEqual(['1471', null]);
      for (const node of parsed.nodes.filter((candidate) => candidate.parentIndex !== null)) {
        expect(node.productOrderNo).toBeNull();
      }
    });

    it('collects materials from every product', () => {
      const parsed = parseBazisXml(multiXml);
      expect(parsed.materials.map((material) => material.name).sort()).toEqual([
        'ЛДСП белый',
        'МДФ 16',
      ]);
    });

    it('keeps single-product header semantics unchanged (no join artifacts)', () => {
      const parsed = parseBazisXml(fixture);
      expect(parsed.productName).toBe('Кухня');
      expect(parsed.productPrice).toBeCloseTo(91750.53);
    });

    it('sums prices treating missing product price as zero, all-missing stays null', () => {
      const withNullPrice = `<Проект Версия="1">
        <Изделие><Наименование>А</Наименование><СписокЭлементов/></Изделие>
        <Изделие><Наименование>Б</Наименование><Цена>50</Цена><СписокЭлементов/></Изделие>
      </Проект>`;
      expect(parseBazisXml(withNullPrice).productPrice).toBeCloseTo(50);
      const allNull = `<Проект Версия="1">
        <Изделие><Наименование>А</Наименование><СписокЭлементов/></Изделие>
        <Изделие><Наименование>Б</Наименование><СписокЭлементов/></Изделие>
      </Проект>`;
      expect(parseBazisXml(allNull).productPrice).toBeNull();
    });
  });

  describe('universal container walk (неизвестные контейнеры в СписокЭлементов)', () => {
    // Формат 1491.xml: внутри СписокЭлементов появился контейнер <Полуфабрикат> с собственным
    // СписокЭлементов; старый whitelist-обход терял такие поддеревья целиком.
    const semiXml = `<Проект Наименование="1491" Версия="1">
      <Изделие><Наименование>KUH</Наименование><Заказ>1491</Заказ><Количество>1</Количество><Цена>10</Цена><СписокЭлементов>
        <Полуфабрикат><Наименование>НМУ.М.R-2Д</Наименование><ТипОбъекта>Полуфабрикат</ТипОбъекта><Количество>2</Количество><Позиция>К1</Позиция><СписокЭлементов>
          <Сборка><Наименование>НМУ.К.М-R</Наименование><ТипОбъекта>Блок</ТипОбъекта><Количество>1</Количество><СписокЭлементов>
            <Объект><ТипОбъекта>Панель</ТипОбъекта><Наименование>Бок</Наименование><Количество>3</Количество>
              <ОсновнойМатериал><Наименование>ЛДСП 16</Наименование></ОсновнойМатериал>
            </Объект>
          </СписокЭлементов></Сборка>
          <Объект><ТипОбъекта>Фурнитура</ТипОбъекта><Наименование>Винт</Наименование><Количество>4</Количество>
            <ОсновнойМатериал><Наименование>Винт 4х30</Наименование></ОсновнойМатериал>
          </Объект>
        </СписокЭлементов></Полуфабрикат>
        <НеизвестныйКонтейнер><Наименование>Новое</Наименование><ТипОбъекта>Нечто</ТипОбъекта><Количество>1</Количество><СписокЭлементов>
          <Объект><ТипОбъекта>Панель</ТипОбъекта><Наименование>Дно</Наименование><Количество>1</Количество>
            <ОсновнойМатериал><Наименование>ХДФ 3</Наименование></ОсновнойМатериал>
          </Объект>
        </СписокЭлементов></НеизвестныйКонтейнер>
      </СписокЭлементов></Изделие>
    </Проект>`;

    it('walks Полуфабрикат subtree: nodes, parent chain, cumulative quantity', () => {
      const parsed = parseBazisXml(semiXml);
      const semi = parsed.nodes.find((node) => node.objectType === 'Полуфабрикат');
      expect(semi).toBeDefined();
      expect(semi?.nodeKind).toBe('object');
      expect(semi?.parentIndex).toBe(0);
      expect(semi?.cumulativeQuantity).toBe(2);
      const assembly = parsed.nodes.find((node) => node.name === 'НМУ.К.М-R');
      expect(assembly?.nodeKind).toBe('assembly');
      expect(assembly?.parentIndex).toBe(semi?.index);
      const panel = parsed.nodes.find((node) => node.name === 'Бок');
      expect(panel?.parentIndex).toBe(assembly?.index);
      expect(panel?.cumulativeQuantity).toBe(6);
      const hardware = parsed.nodes.find((node) => node.name === 'Винт');
      expect(hardware?.parentIndex).toBe(semi?.index);
      expect(hardware?.cumulativeQuantity).toBe(8);
    });

    it('walks any future unknown container tag with СписокЭлементов', () => {
      const parsed = parseBazisXml(semiXml);
      const unknown = parsed.nodes.find((node) => node.name === 'Новое');
      expect(unknown).toBeDefined();
      expect(unknown?.nodeKind).toBe('object');
      const panel = parsed.nodes.find((node) => node.name === 'Дно');
      expect(panel?.parentIndex).toBe(unknown?.index);
    });

    it('counts panels/materials from dropped-before subtrees', () => {
      const parsed = parseBazisXml(semiXml);
      expect(parsed.summary.panels).toBe(2);
      expect(parsed.summary.hardware).toBe(1);
      expect(parsed.summary.totalNodes).toBe(7);
      expect(parsed.materials.map((material) => material.name).sort()).toEqual([
        'Винт 4х30',
        'ЛДСП 16',
        'ХДФ 3',
      ]);
    });

    it('keeps raw free of СписокЭлементов for container nodes of any tag', () => {
      const parsed = parseBazisXml(semiXml);
      for (const node of parsed.nodes) {
        expect(node.raw).not.toHaveProperty('СписокЭлементов');
      }
    });
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
