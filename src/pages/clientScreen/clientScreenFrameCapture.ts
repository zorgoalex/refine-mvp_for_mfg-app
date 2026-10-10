import {
  CLIENT_SCREEN_FRAME_LIMITS,
  clientScreenFrameAttribute,
  clientScreenFrameTag,
  type ClientScreenFrameElement,
  type ClientScreenFrameNode,
} from './clientScreenFrameTree';

/**
 * Manager window only: turns the live nodes of one tab into the inert tree of `clientScreenFrameTree`.
 * It reads the page and changes nothing in it. The node types are the few members it needs, so the
 * walk is tested without a browser.
 */
export interface FrameSourceNode {
  nodeType: number;
  nodeValue?: string | null;
}

export interface FrameSourceElement extends FrameSourceNode {
  tagName: string;
  namespaceURI?: string | null;
  attributes: ArrayLike<{ name: string; value: string }>;
  childNodes: ArrayLike<FrameSourceNode>;
  scrollTop?: number;
  scrollLeft?: number;
  /** Current state of a form control, which the attributes do not hold. */
  value?: unknown;
  checked?: unknown;
  selected?: unknown;
  type?: unknown;
}

/**
 * Turns a picture or a canvas of the page into an inline image, or `null` when it cannot be read
 * yet. A frame carries its pictures itself: an address would die with the manager's screen and
 * would make the customer window ask the network for something.
 */
export type FrameImageEncoder = (element: FrameSourceElement) => string | null;

const ELEMENT = 1;
const TEXT = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';
export const CLIENT_SCREEN_FRAME_SCROLL_ATTRIBUTE = 'data-cs-scroll';

const isElement = (node: FrameSourceNode): node is FrameSourceElement => node.nodeType === ELEMENT;

/** A picture is drawn from what the page already shows; one that cannot be read is an empty box of its size. */
function picture(element: FrameSourceElement, encode: FrameImageEncoder): ClientScreenFrameElement {
  const attributes: Record<string, string> = {};
  for (const { name, value } of Array.from(element.attributes)) {
    if (name.toLowerCase() === 'src') continue;
    const kept = clientScreenFrameAttribute('img', false, name, value);
    if (kept !== null) attributes[name] = kept;
  }
  let image: string | null = null;
  try {
    image = encode(element);
  } catch {
    image = null;
  }
  if (image !== null && clientScreenFrameAttribute('img', false, 'src', image) !== null) attributes.src = image;
  return { t: 'img', a: attributes };
}

/** The value a control shows right now goes into the attribute the copy is drawn from. */
function controlState(element: FrameSourceElement, tag: string, attributes: Record<string, string>): string | null {
  if (tag === 'input') {
    const type = String(element.type ?? attributes.type ?? 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if (element.checked === true) attributes.checked = '';
      else delete attributes.checked;
    } else if (type === 'password' || type === 'file' || type === 'hidden') {
      delete attributes.value;
    } else if (typeof element.value === 'string') {
      attributes.value = element.value;
    }
  }
  if (tag === 'option') {
    if (element.selected === true) attributes.selected = '';
    else delete attributes.selected;
  }
  return tag === 'textarea' && typeof element.value === 'string' ? element.value : null;
}

export interface FrameCaptureResult {
  /** `null` — the tab is over a limit: it is reported as too large, never cut. */
  tree: ClientScreenFrameElement | null;
}

export function captureClientScreenFrame(root: FrameSourceElement, encode: FrameImageEncoder): FrameCaptureResult {
  const budget = { nodes: 0, chars: 0 };
  let over = false;
  const spend = (chars: number) => {
    budget.chars += chars;
    if (budget.chars > CLIENT_SCREEN_FRAME_LIMITS.chars) over = true;
  };

  const walk = (node: FrameSourceNode, depth: number, parentSvg: boolean): ClientScreenFrameNode | null => {
    if (over) return null;
    if (++budget.nodes > CLIENT_SCREEN_FRAME_LIMITS.nodes || depth > CLIENT_SCREEN_FRAME_LIMITS.depth) {
      over = true;
      return null;
    }
    if (node.nodeType === TEXT) {
      const text = node.nodeValue ?? '';
      spend(text.length);
      return text;
    }
    if (!isElement(node)) return null;
    const svg = node.namespaceURI === SVG_NS;
    // An SVG subtree holds only SVG, and SVG starts only at an <svg>: anything else there is not copied.
    if (svg !== parentSvg && !(svg && node.tagName === 'svg')) return null;
    const rawTag = svg ? node.tagName : node.tagName.toLowerCase();
    if (!svg && (rawTag === 'canvas' || rawTag === 'img')) {
      const image = picture(node, encode);
      for (const [name, value] of Object.entries(image.a ?? {})) spend(name.length + value.length);
      return over ? null : image;
    }
    const tag = clientScreenFrameTag(rawTag, svg);
    if (!tag) return null;

    const attributes: Record<string, string> = {};
    let count = 0;
    for (const { name, value } of Array.from(node.attributes)) {
      const kept = clientScreenFrameAttribute(tag.t, svg, name, value);
      if (kept === null || count >= CLIENT_SCREEN_FRAME_LIMITS.attributes - 2) continue;
      attributes[name] = kept;
      count += 1;
    }
    const text = svg ? null : controlState(node, tag.t, attributes);
    if ((node.scrollTop ?? 0) > 0 || (node.scrollLeft ?? 0) > 0) {
      attributes[CLIENT_SCREEN_FRAME_SCROLL_ATTRIBUTE] = `${Math.round(node.scrollTop ?? 0)},${Math.round(node.scrollLeft ?? 0)}`;
    }
    for (const [name, value] of Object.entries(attributes)) spend(name.length + value.length);

    const out: ClientScreenFrameElement = { ...tag };
    if (Object.keys(attributes).length) out.a = attributes;
    const children: ClientScreenFrameNode[] = [];
    if (text !== null) {
      spend(text.length);
      budget.nodes += 1;
      if (text) children.push(text);
    } else {
      for (const child of Array.from(node.childNodes)) {
        const copied = walk(child, depth + 1, svg);
        if (over) return null;
        if (copied !== null && copied !== '') children.push(copied);
      }
    }
    if (children.length) out.c = children;
    return out;
  };

  const tree = walk(root, 0, false);
  return { tree: over || !tree || typeof tree === 'string' ? null : tree };
}

export interface FrameShell {
  tag: 'div' | 'section' | 'main' | 'article' | 'aside' | 'span';
  cls: string;
  data: Record<string, string>;
  /** Inline style: the variables and inherited values the tab's own styles read from its ancestors. */
  style: string;
}

export interface FrameSurroundings {
  /** Ancestors of the tab from the outermost down: tag, classes and data attributes, nothing inside. */
  shells: FrameShell[];
  root: { htmlCls: string; bodyCls: string; htmlData: Record<string, string>; bodyData: Record<string, string>; htmlStyle: string; bodyStyle: string };
}

interface ShellSource {
  tagName: string;
  className?: unknown;
  attributes: ArrayLike<{ name: string; value: string }>;
  parentElement?: ShellSource | null;
  getAttribute?: (name: string) => string | null;
}

const SHELL_TAGS = new Set(['div', 'section', 'main', 'article', 'aside', 'span']);
export const CLIENT_SCREEN_FRAME_SHELL_LIMIT = 40;

function dataOf(element: ShellSource): Record<string, string> {
  const data: Record<string, string> = {};
  let count = 0;
  for (const { name, value } of Array.from(element.attributes)) {
    if (!/^data-[a-z0-9-]{1,60}$/.test(name) || value.length > 200 || count >= 20) continue;
    data[name] = value;
    count += 1;
  }
  return data;
}

const classOf = (element: ShellSource): string => (typeof element.className === 'string' ? element.className : element.getAttribute?.('class') ?? '').slice(0, 1000);

/** An inline style that is too long or reaches outside the page is left out whole, never cut. */
function safeStyle(element: ShellSource): string {
  const value = element.getAttribute?.('style') ?? '';
  return value.length > 4000 ? '' : clientScreenFrameAttribute('div', false, 'style', value) ?? '';
}

/**
 * What the styles of the tab depend on outside the tab: the chain of its ancestors (so that
 * selectors like `.order-form .cut-page` match) and the theme attributes of the page.
 */
export function captureFrameSurroundings(node: ShellSource, html: ShellSource, body: ShellSource): FrameSurroundings {
  const shells: FrameShell[] = [];
  for (let current = node.parentElement ?? null; current && current !== body && current !== html; current = current.parentElement ?? null) {
    const tag = current.tagName.toLowerCase();
    shells.unshift({ tag: (SHELL_TAGS.has(tag) ? tag : 'div') as FrameShell['tag'], cls: classOf(current), data: dataOf(current), style: safeStyle(current) });
  }
  return {
    // The nearest ancestors matter most for selectors: the outermost ones are dropped first.
    shells: shells.slice(-CLIENT_SCREEN_FRAME_SHELL_LIMIT),
    root: {
      htmlCls: classOf(html), bodyCls: classOf(body), htmlData: dataOf(html), bodyData: dataOf(body),
      htmlStyle: safeStyle(html), bodyStyle: safeStyle(body),
    },
  };
}

export const CLIENT_SCREEN_FRAME_STYLE_LIMITS = { blocks: 600, chars: 4_000_000 } as const;

interface StyleSheetSource {
  cssRules: ArrayLike<{ cssText: string }>;
}

/**
 * The text of every stylesheet of the page, one block per sheet. Text, not addresses: the customer
 * window draws the tab without loading a stylesheet. `null` — a sheet cannot be read or the styles
 * are over a limit, and a tab without its styles is not shown at all.
 */
export function captureFrameStyles(sheets: ArrayLike<StyleSheetSource>): string[] | null {
  const blocks: string[] = [];
  let chars = 0;
  for (const sheet of Array.from(sheets)) {
    let text = '';
    try {
      for (const rule of Array.from(sheet.cssRules)) text += `${rule.cssText}\n`;
    } catch {
      return null;
    }
    if (!text) continue;
    chars += text.length;
    blocks.push(text);
    if (blocks.length > CLIENT_SCREEN_FRAME_STYLE_LIMITS.blocks || chars > CLIENT_SCREEN_FRAME_STYLE_LIMITS.chars) return null;
  }
  return blocks;
}
