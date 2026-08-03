import { XMLParser } from 'fast-xml-parser';

export interface ParsedBazisNode {
  index: number;
  parentIndex: number | null;
  seq: number;
  nodeKind: 'product' | 'assembly' | 'block' | 'object';
  productOrderNo: string | null;
  objectType: string | null;
  name: string | null;
  detailCode: string | null;
  position: string | null;
  designation: string | null;
  quantity: number | null;
  cumulativeQuantity: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  thicknessMm: number | null;
  price: number | null;
  isRectangular: boolean | null;
  textureOrientation: string | null;
  mainMaterialName: string | null;
  raw: Record<string, unknown>;
}

export interface ParsedBazisMaterialUsage {
  name: string;
  kindGuess: 'sheet' | 'film' | 'edge' | 'hardware';
  usageCount: number;
}

export interface ParsedBazisRevision {
  bazisVersion: string | null;
  bazisOrderNo: string | null;
  productName: string | null;
  productPrice: number | null;
  nodes: ParsedBazisNode[];
  materials: ParsedBazisMaterialUsage[];
  summary: {
    totalNodes: number;
    panels: number;
    hardware: number;
    assemblies: number;
    blocks: number;
    uniqueMaterials: number;
  };
}

export class BazisXmlParseError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export const MAX_BAZIS_NODES = 20_000;

const ARRAY_TAGS = new Set([
  'Изделие',
  'Объект',
  'Сборка',
  'Блок',
  'Кромка',
  'Отверстие',
  'Свойство',
  'СопутствующийМатериал',
  'Пласть',
  'СдельнаяОперация',
  'Материал',
]);

// nodeKind по имени тега; любой другой тег (Полуфабрикат, будущие контейнеры) — 'object':
// структура дерева от kind не зависит, реальный тип узла хранится в objectType/raw.
const NODE_KIND_BY_TAG: Record<string, ParsedBazisNode['nodeKind']> = {
  Сборка: 'assembly',
  Блок: 'block',
};

type BazisElement = Record<string, unknown>;

// `fast-xml-parser` groups siblings by tag name unless preserveOrder is enabled. We keep the
// default grouped mode for simpler tree traversal, so mixed sibling interleave is not preserved:
// siblings are walked per tag in first-occurrence order. UI can still sort via `Позиция`/`seq`.
export function parseBazisXml(source: Buffer | string): ParsedBazisRevision {
  let text = Buffer.isBuffer(source) ? source.toString('utf8') : source;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (/<!DOCTYPE/i.test(text.slice(0, 4096))) {
    throw new BazisXmlParseError('DOCTYPE запрещён');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    trimValues: true,
    // Любой прямой ребёнок СписокЭлементов — массив узлов независимо от имени тега
    // (универсальный обход: новые контейнеры вроде Полуфабрикат не должны теряться).
    isArray: (name, jPath) =>
      ARRAY_TAGS.has(name) || /(^|\.)СписокЭлементов\.[^.]+$/.test(jPath),
    processEntities: false,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new BazisXmlParseError(`XML не распарсился: ${(error as Error).message}`);
  }

  const project = doc['Проект'] as BazisElement | undefined;
  // Проект может содержать несколько Изделие (экспорт проекта целиком, не одного изделия);
  // каждое становится отдельным root-узлом (parentIndex=null).
  const products = (project?.['Изделие'] ?? []) as BazisElement[];
  if (!project || products.length === 0) {
    throw new BazisXmlParseError('Не найден корень Проект/Изделие');
  }

  const nodes: ParsedBazisNode[] = [];
  const materialUsage = new Map<
    string,
    { name: string; kindGuess: ParsedBazisMaterialUsage['kindGuess']; count: number }
  >();

  const pushNode = (input: Omit<ParsedBazisNode, 'index'>): number => {
    if (nodes.length >= MAX_BAZIS_NODES) {
      throw new BazisXmlParseError(`Слишком большой проект: более ${MAX_BAZIS_NODES} узлов`);
    }

    const index = nodes.length;
    nodes.push({ ...input, index });
    return index;
  };

  const toNumber = (value: unknown): number | null => {
    if (value === null || value === undefined || value === '') {
      return null;
    }
    const num = Number(String(value).replace(',', '.'));
    return Number.isFinite(num) ? num : null;
  };

  // Габариты панелей в ERP храним в целых миллиметрах. Размеры физически
  // положительные, поэтому Math.round даёт требуемое правило half-up:
  // дробная часть < 0.5 — вниз, >= 0.5 — вверх.
  const roundPanelDimensionMm = (value: number | null): number | null =>
    value == null ? null : Math.round(value);

  const toText = (value: unknown): string | null => {
    if (value === null || value === undefined) {
      return null;
    }
    const str = String(value).trim();
    return str === '' ? null : str;
  };

  const ynToBool = (value: unknown): boolean | null => {
    if (value === 'Y') {
      return true;
    }
    if (value === 'N') {
      return false;
    }
    return null;
  };

  const stripChildren = (element: BazisElement): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...element };
    delete copy['СписокЭлементов'];
    return copy;
  };

  const userPropertyValue = (
    element: BazisElement,
    acceptedNames: ReadonlySet<string>,
  ): string | null => {
    const propertyCandidates: unknown[] = [];
    const nested = element['ПользовательскиеСвойства'];
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      propertyCandidates.push((nested as BazisElement)['Свойство']);
    }
    propertyCandidates.push(element['Свойство']);

    for (const candidate of propertyCandidates) {
      const properties = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
      for (const property of properties) {
        if (typeof property !== 'object' || property === null || Array.isArray(property)) {
          continue;
        }
        const row = property as BazisElement;
        const name = toText(row['Имя'] ?? row['Наименование']);
        if (
          name &&
          acceptedNames.has(name.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' '))
        ) {
          return toText(row['Значение']);
        }
      }
    }
    return null;
  };

  const recordMaterial = (
    name: string | null,
    kind: ParsedBazisMaterialUsage['kindGuess'],
  ): void => {
    if (!name) {
      return;
    }

    // Ключ = (контекст, имя): одно имя в разных контекстах (лист/пласть/кромка)
    // должно давать отдельные записи — маппинг материалов ведётся по source_kind.
    const key = `${kind}:${name}`;
    const existing = materialUsage.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }

    materialUsage.set(key, { name, kindGuess: kind, count: 1 });
  };

  const collectMaterials = (element: BazisElement, objectType: string | null): void => {
    const main = element['ОсновнойМатериал'] as BazisElement | undefined;
    const mainName = toText(main?.['Наименование']);
    if (objectType === 'Панель') {
      recordMaterial(mainName, 'sheet');
    } else if (objectType === 'Фурнитура') {
      recordMaterial(mainName, 'hardware');
    }

    const customFilmName =
      objectType === 'Панель' ? userPropertyValue(element, new Set(['пленка'])) : null;
    if (customFilmName) {
      recordMaterial(customFilmName, 'film');
    } else {
      for (const faceKey of ['ОблицовкаПласти1', 'ОблицовкаПласти2']) {
        const face = element[faceKey] as BazisElement | undefined;
        const plasti = (face?.['Пласть'] ?? []) as BazisElement[];
        for (const plast of plasti) {
          recordMaterial(toText(plast['Наименование']), 'film');
        }
      }
    }

    for (const edgeKey of ['СписокКромок1', 'СписокКромок2', 'СписокКромок3', 'СписокКромок4']) {
      const list = element[edgeKey] as BazisElement | undefined;
      const edges = (list?.['Кромка'] ?? []) as BazisElement[];
      for (const edge of edges) {
        recordMaterial(toText(edge['Наименование']), 'edge');
      }
    }
  };

  const walk = (
    element: BazisElement,
    kind: ParsedBazisNode['nodeKind'],
    parentIndex: number | null,
    seq: number,
    parentQty: number,
  ): void => {
    const objectType = toText(element['ТипОбъекта']);
    const quantity = toNumber(element['Количество']);
    const cumulative = (quantity ?? 1) * parentQty;
    const sourceHeightMm =
      toNumber(element['Длина_готовой_детали']) ?? toNumber(element['Длина']);
    const sourceWidthMm =
      toNumber(element['Ширина_готовой_детали']) ?? toNumber(element['Ширина']);
    const swapPanelDimensions = objectType === 'Панель';
    const index = pushNode({
      parentIndex,
      seq,
      nodeKind: kind,
      productOrderNo: kind === 'product' && parentIndex === null ? toText(element['Заказ']) : null,
      objectType,
      name: toText(element['Наименование']),
      detailCode: toText(element['КодДетали']),
      position: toText(element['Позиция']),
      designation: toText(element['Обозначение']),
      quantity,
      cumulativeQuantity: cumulative,
      // В ERP высота детали хранится в lengthMm. Для импортируемых панелей
      // оси Базиса разворачиваем: исходная ширина становится высотой ERP,
      // исходная высота — шириной ERP. Размеры контейнеров/фурнитуры не меняем.
      lengthMm: swapPanelDimensions ? roundPanelDimensionMm(sourceWidthMm) : sourceHeightMm,
      widthMm: swapPanelDimensions ? roundPanelDimensionMm(sourceHeightMm) : sourceWidthMm,
      heightMm: toNumber(element['Высота']),
      thicknessMm: toNumber(element['ОбщаяТолщина']) ?? toNumber(element['Толщина']),
      price: toNumber(element['Цена']),
      isRectangular: ynToBool(element['Прямоугольная']),
      textureOrientation: toText(element['ОриентацияТекстуры']),
      mainMaterialName: toText(
        (element['ОсновнойМатериал'] as BazisElement | undefined)?.['Наименование'],
      ),
      raw: stripChildren(element),
    });

    collectMaterials(element, objectType);

    const children = element['СписокЭлементов'] as BazisElement | undefined;
    if (!children || typeof children !== 'object') {
      return;
    }

    // Универсальный обход: каждый элемент-ребёнок СписокЭлементов — узел дерева,
    // независимо от имени тега; рекурсия собирает структуру от листьев вверх.
    let childSeq = 0;
    for (const [tag, value] of Object.entries(children)) {
      if (tag.startsWith('@_') || tag === '#text' || !Array.isArray(value)) {
        continue;
      }
      const childKind = NODE_KIND_BY_TAG[tag] ?? 'object';
      for (const child of value) {
        if (child === null || typeof child !== 'object') {
          continue;
        }
        walk(child as BazisElement, childKind, index, childSeq++, cumulative);
      }
    }
  };

  products.forEach((product, productSeq) => {
    walk(product, 'product', null, productSeq, 1);
  });

  const materials = [...materialUsage.values()]
    .map((value) => ({
      name: value.name,
      kindGuess: value.kindGuess,
      usageCount: value.count,
    }))
    .sort((left, right) => right.usageCount - left.usageCount);

  const count = (predicate: (node: ParsedBazisNode) => boolean): number =>
    nodes.filter(predicate).length;

  const productNames = products
    .map((product) => toText(product['Наименование']))
    .filter((name): name is string => name !== null);
  const productPrices = products
    .map((product) => toNumber(product['Цена']))
    .filter((price): price is number => price !== null);

  return {
    bazisVersion: toText(project['@_Версия']),
    bazisOrderNo: toText(project['@_Наименование']),
    productName: productNames.length > 0 ? productNames.join(' + ') : null,
    productPrice:
      productPrices.length > 0
        ? productPrices.reduce((sum, price) => sum + price, 0)
        : null,
    nodes,
    materials,
    summary: {
      totalNodes: nodes.length,
      panels: count((node) => node.objectType === 'Панель'),
      hardware: count((node) => node.objectType === 'Фурнитура'),
      assemblies: count((node) => node.nodeKind === 'assembly'),
      blocks: count((node) => node.nodeKind === 'block'),
      uniqueMaterials: materials.length,
    },
  };
}
