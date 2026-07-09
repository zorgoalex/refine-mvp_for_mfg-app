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

export interface XmlPreviewResult {
  productName: string | null;
  totalNodes: number;
  tree: XmlPreviewNode[];
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
  const product = project ? childByTag(project, 'Изделие') : null;
  if (!project || !product) {
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

  const walk = (element: Element, fallbackTitle: string): XmlPreviewNode => {
    const node: XmlPreviewNode = {
      key: next(),
      title: buildTitle(element, fallbackTitle),
    };

    const list = childByTag(element, 'СписокЭлементов');
    if (!list) {
      return node;
    }

    const children: XmlPreviewNode[] = [];
    for (const child of directChildren(list, 'Объект')) {
      children.push(walk(child, 'Объект'));
    }
    for (const tag of CONTAINER_TAGS) {
      for (const container of directChildren(list, tag)) {
        children.push(walk(container, tag));
      }
    }

    if (children.length > 0) {
      node.children = children;
    }
    return node;
  };

  const root = walk(product, 'Изделие');
  return {
    productName: textOfChild(product, 'Наименование'),
    totalNodes: counter,
    tree: [root],
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
