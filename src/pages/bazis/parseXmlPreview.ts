/**
 * Клиентский предпросмотр Bazis XML: строит дерево узлов прямо из файла
 * (DOMParser), ДО отправки на backend — чтобы показать состав проекта
 * на первом шаге визарда импорта.
 *
 * Упрощённое зеркало backend-парсера (bazis-xml-parser.ts): обходит
 * Проект → Изделие → СписокЭлементов (Объект / Сборка / Блок).
 */

export interface XmlPreviewNode {
  key: number;
  title: string;
  children?: XmlPreviewNode[];
}

export interface XmlPreviewBreakdown {
  /** Имена всех узлов (в порядке обхода) */
  allNodes: string[];
  panels: string[];
  hardware: string[];
  assemblies: string[];
  blocks: string[];
  /** Уникальные материалы в паре с контекстом, как их считает backend */
  materials: string[];
}

export interface XmlPreviewResult {
  productName: string | null;
  totalNodes: number;
  tree: XmlPreviewNode[];
  breakdown: XmlPreviewBreakdown;
}

export class XmlPreviewError extends Error {}

const MAX_PREVIEW_NODES = 20_000;
const CONTAINER_TAGS = ['Сборка', 'Блок'];

export function parseXmlPreview(xmlText: string): XmlPreviewResult {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new XmlPreviewError('XML не распарсился');
  }

  const project = childByTag(doc, 'Проект');
  // Проект может содержать несколько Изделие — каждое отдельный корень дерева
  // (зеркало backend bazis-xml-parser).
  const products = project ? directChildren(project, 'Изделие') : [];
  if (!project || products.length === 0) {
    throw new XmlPreviewError('Не найден корень Проект/Изделие');
  }

  let counter = 0;
  const next = (): number => {
    counter += 1;
    if (counter > MAX_PREVIEW_NODES) {
      throw new XmlPreviewError(`Слишком большой проект: более ${MAX_PREVIEW_NODES} узлов`);
    }
    return counter;
  };

  const breakdown: XmlPreviewBreakdown = {
    allNodes: [],
    panels: [],
    hardware: [],
    assemblies: [],
    blocks: [],
    materials: [],
  };
  // Уникальность материалов — по паре (контекст, имя), как в backend-парсере.
  const materialKeys = new Set<string>();
  const recordMaterial = (kindLabel: string, name: string | null): void => {
    if (!name) return;
    const key = `${kindLabel}:${name.toLowerCase()}`;
    if (materialKeys.has(key)) return;
    materialKeys.add(key);
    breakdown.materials.push(`${name} (${kindLabel})`);
  };

  const collectMaterials = (element: Element, objectType: string | null): void => {
    const main = childByTag(element, 'ОсновнойМатериал');
    const mainName = main ? textOfChild(main, 'Наименование') : null;
    if (objectType === 'Панель') recordMaterial('лист', mainName);
    if (objectType === 'Фурнитура') recordMaterial('фурнитура', mainName);

    for (const faceKey of ['ОблицовкаПласти1', 'ОблицовкаПласти2']) {
      const face = childByTag(element, faceKey);
      if (!face) continue;
      for (const plast of directChildren(face, 'Пласть')) {
        recordMaterial('плёнка', textOfChild(plast, 'Наименование'));
      }
    }

    for (const edgeKey of ['СписокКромок1', 'СписокКромок2', 'СписокКромок3', 'СписокКромок4']) {
      const list = childByTag(element, edgeKey);
      if (!list) continue;
      for (const edge of directChildren(list, 'Кромка')) {
        recordMaterial('кромка', textOfChild(edge, 'Наименование'));
      }
    }
  };

  const walk = (element: Element, fallbackTitle: string, kind: 'product' | 'assembly' | 'block' | 'object'): XmlPreviewNode => {
    const title = buildTitle(element, fallbackTitle);
    const node: XmlPreviewNode = {
      key: next(),
      title,
    };

    breakdown.allNodes.push(title);
    const objectType = textOfChild(element, 'ТипОбъекта');
    if (objectType === 'Панель') breakdown.panels.push(title);
    if (objectType === 'Фурнитура') breakdown.hardware.push(title);
    if (kind === 'assembly') breakdown.assemblies.push(title);
    if (kind === 'block') breakdown.blocks.push(title);
    collectMaterials(element, objectType);

    const list = childByTag(element, 'СписокЭлементов');
    if (!list) {
      return node;
    }

    const children: XmlPreviewNode[] = [];
    for (const child of directChildren(list, 'Объект')) {
      children.push(walk(child, 'Объект', 'object'));
    }
    for (const tag of CONTAINER_TAGS) {
      for (const container of directChildren(list, tag)) {
        children.push(walk(container, tag, tag === 'Сборка' ? 'assembly' : 'block'));
      }
    }

    if (children.length > 0) {
      node.children = children;
    }
    return node;
  };

  const roots = products.map((product) => walk(product, 'Изделие', 'product'));
  const productNames = products
    .map((product) => textOfChild(product, 'Наименование'))
    .filter((name): name is string => name !== null);
  return {
    productName: productNames.length > 0 ? productNames.join(' + ') : null,
    totalNodes: counter,
    tree: roots,
    breakdown,
  };
}

function buildTitle(element: Element, fallbackTitle: string): string {
  const name = textOfChild(element, 'Наименование') ?? fallbackTitle;
  const objectType = textOfChild(element, 'ТипОбъекта');
  if (objectType !== 'Панель') {
    return name;
  }

  const length = numberOfChild(element, 'Длина_готовой_детали') ?? numberOfChild(element, 'Длина');
  const width = numberOfChild(element, 'Ширина_готовой_детали') ?? numberOfChild(element, 'Ширина');
  const quantity = textOfChild(element, 'Количество');
  const parts = [
    length != null && width != null ? `${length}x${width}` : null,
    quantity ? `кол-во ${quantity}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `${name} — ${parts.join(', ')}` : name;
}

function childByTag(parent: ParentNode, tag: string): Element | null {
  for (const child of Array.from(parent.children ?? [])) {
    if (child.tagName === tag) {
      return child;
    }
  }
  return null;
}

function directChildren(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter((child) => child.tagName === tag);
}

function textOfChild(parent: Element, tag: string): string | null {
  const child = childByTag(parent, tag);
  const text = child?.textContent?.trim();
  return text ? text : null;
}

function numberOfChild(parent: Element, tag: string): number | null {
  const text = textOfChild(parent, tag);
  if (text == null) return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) ? Math.round(value) : null;
}
