/**
 * A "frame" is an inert copy of one whole tab of the manager's order screen (cut, workshops,
 * additional): those tabs are shown to the customer exactly as the manager sees them, with one tick
 * per tab instead of a tick per field.
 *
 * The copy never travels as HTML. The manager window turns the live nodes into a plain tree, the
 * customer window checks that tree with the same rules and builds elements from it one by one —
 * no markup is ever parsed on the customer's side. The rules are a positive list: what is not named
 * here is not in the copy. Nothing that runs, navigates or loads is on the list: no scripts, no
 * frames, no links, no event attributes, and no addresses at all — a picture is carried inside the
 * tree as an inline image, so the customer window makes no request to draw a frame.
 *
 * This module is pure and has no dependencies: both windows import it.
 */
export type ClientScreenFrameNode = string | ClientScreenFrameElement;

export interface ClientScreenFrameElement {
  /** Tag name: lower case for HTML, as written for SVG. */
  t: string;
  /** Present and 1 for an SVG element. */
  s?: 1;
  a?: Record<string, string>;
  c?: ClientScreenFrameNode[];
}

export const CLIENT_SCREEN_FRAME_LIMITS = {
  nodes: 60_000,
  depth: 120,
  /** Characters of all texts, attribute names and attribute values together. */
  chars: 8_000_000,
  attributes: 80,
} as const;

const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'article', 'aside', 'b', 'bdi', 'bdo', 'blockquote', 'br', 'button', 'caption', 'cite', 'code',
  'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'main',
  'mark', 'nav', 'ol', 'optgroup', 'option', 'p', 'pre', 'progress', 'q', 's', 'samp', 'section', 'select', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul',
  'var', 'wbr',
]);

const SVG_TAGS = new Set([
  'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textPath', 'title',
  'desc', 'defs', 'symbol', 'use', 'image', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient',
  'stop', 'filter', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feFlood', 'feFuncA', 'feFuncB',
  'feFuncG', 'feFuncR', 'feGaussianBlur', 'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'feDropShadow',
]);

/** Dropped together with everything inside. Everything else unknown keeps its children in a neutral box. */
const DROPPED_TAGS = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'template',
  'noscript', 'title', 'head', 'foreignobject', 'animate', 'animatemotion', 'animatetransform', 'set', 'audio', 'video',
  'source', 'track', 'portal', 'dialog', 'slot', 'math',
]);

const HTML_ATTRIBUTES = new Set([
  'class', 'style', 'id', 'title', 'alt', 'role', 'dir', 'lang', 'hidden', 'open', 'colspan', 'rowspan', 'span', 'scope',
  'width', 'height', 'align', 'valign', 'nowrap', 'value', 'checked', 'selected', 'disabled', 'readonly', 'placeholder',
  'type', 'size', 'rows', 'cols', 'min', 'max', 'step', 'multiple', 'start', 'reversed', 'for', 'unselectable', 'wrap',
  'cellpadding', 'cellspacing', 'border', 'loading', 'decoding',
]);

/** Input kinds whose value is never copied, and kinds that could act are drawn as plain text boxes. */
const INPUT_TYPES = new Set([
  'text', 'search', 'number', 'checkbox', 'radio', 'range', 'date', 'time', 'datetime-local', 'month', 'week', 'tel',
  'email', 'url', 'color', 'button',
]);

const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,79}$/;
/** Only a raster image carried in the tree itself: no blob of another window, no path, no SVG document. */
const IMAGE_ADDRESS = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]*$/;
const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]{0,199}$/;
/** A style value that reaches outside the page or runs something is dropped whole. */
const UNSAFE_STYLE = /expression\s*\(|javascript\s*:|vbscript\s*:|@import|behavior\s*:|-moz-binding|image-set\s*\(|\\|url\s*\(\s*["']?\s*(?!data:image\/(?:png|jpeg|gif|webp);base64,|#)/i;

/** `null` — the element and its subtree are not copied; otherwise the tag to draw. */
export function clientScreenFrameTag(tag: string, svg: boolean): { t: string; s?: 1 } | null {
  if (typeof tag !== 'string' || !NAME.test(tag)) return null;
  if (DROPPED_TAGS.has(tag.toLowerCase())) return null;
  if (svg) return SVG_TAGS.has(tag) ? { t: tag, s: 1 } : { t: 'g', s: 1 };
  const lower = tag.toLowerCase();
  if (lower === 'form') return { t: 'div' };
  return HTML_TAGS.has(lower) ? { t: lower } : { t: 'span' };
}

/** The value to keep, or `null` when the attribute is not copied. */
export function clientScreenFrameAttribute(tag: string, svg: boolean, name: string, value: string): string | null {
  if (typeof name !== 'string' || typeof value !== 'string' || !NAME.test(name)) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith('on')) return null;
  if (lower === 'style') return UNSAFE_STYLE.test(value) ? null : value;
  if (lower === 'href' || lower === 'xlink:href') {
    if (!svg) return null;
    if (tag === 'use' || tag === 'textPath' || tag === 'linearGradient' || tag === 'radialGradient' || tag === 'pattern') {
      return FRAGMENT.test(value) ? value : null;
    }
    if (tag === 'image') return IMAGE_ADDRESS.test(value) ? value : null;
    return null;
  }
  if (lower === 'src') return !svg && tag === 'img' && IMAGE_ADDRESS.test(value) ? value : null;
  if (lower === 'type' && !svg && tag === 'input') return INPUT_TYPES.has(value.toLowerCase()) ? value.toLowerCase() : 'text';
  if (lower.startsWith('data-') || lower.startsWith('aria-')) return value;
  if (svg) {
    // Presentation attributes of SVG are many; none of them runs or loads once on*, href and style are handled.
    if (lower === 'srcdoc' || lower === 'action' || lower === 'formaction' || lower === 'src' || lower === 'xml:base' || lower === 'base') return null;
    return UNSAFE_STYLE.test(value) ? null : value;
  }
  return HTML_ATTRIBUTES.has(lower) ? value : null;
}

/**
 * Checks a tree that came over the wire and returns a clean copy, or `null` when it is not a frame
 * tree at all or is over a limit. A frame is all-or-nothing: an oversized one is never cut.
 */
export function cleanClientScreenFrameTree(input: unknown): ClientScreenFrameElement | null {
  const budget = { nodes: 0, chars: 0 };
  const walk = (node: unknown, depth: number, parentSvg: boolean): ClientScreenFrameNode | null | undefined => {
    if (++budget.nodes > CLIENT_SCREEN_FRAME_LIMITS.nodes) return undefined;
    if (typeof node === 'string') {
      budget.chars += node.length;
      return budget.chars > CLIENT_SCREEN_FRAME_LIMITS.chars ? undefined : node;
    }
    if (!node || typeof node !== 'object' || Array.isArray(node) || depth > CLIENT_SCREEN_FRAME_LIMITS.depth) return undefined;
    const raw = node as { t?: unknown; s?: unknown; a?: unknown; c?: unknown };
    if (typeof raw.t !== 'string' || (raw.s !== undefined && raw.s !== 1)) return undefined;
    // An element is SVG only inside an SVG root: the namespace cannot be claimed in the middle of HTML.
    const svg = raw.s === 1 && (parentSvg || raw.t === 'svg');
    if (raw.s === 1 && !svg) return undefined;
    if (parentSvg && raw.s !== 1) return undefined;
    const tag = clientScreenFrameTag(raw.t, svg);
    if (!tag) return null;
    const out: ClientScreenFrameElement = { ...tag };
    if (raw.a !== undefined) {
      if (!raw.a || typeof raw.a !== 'object' || Array.isArray(raw.a)) return undefined;
      const entries = Object.entries(raw.a as Record<string, unknown>);
      if (entries.length > CLIENT_SCREEN_FRAME_LIMITS.attributes) return undefined;
      const attributes: Record<string, string> = {};
      for (const [name, value] of entries) {
        if (typeof value !== 'string') return undefined;
        budget.chars += name.length + value.length;
        if (budget.chars > CLIENT_SCREEN_FRAME_LIMITS.chars) return undefined;
        const kept = clientScreenFrameAttribute(tag.t, svg, name, value);
        if (kept !== null) attributes[name] = kept;
      }
      if (Object.keys(attributes).length) out.a = attributes;
    }
    if (raw.c !== undefined) {
      if (!Array.isArray(raw.c)) return undefined;
      const children: ClientScreenFrameNode[] = [];
      for (const child of raw.c) {
        const cleaned = walk(child, depth + 1, svg);
        if (cleaned === undefined) return undefined;
        if (cleaned !== null) children.push(cleaned);
      }
      if (children.length) out.c = children;
    }
    return out;
  };
  const root = walk(input, 0, false);
  return root && typeof root !== 'string' ? root : null;
}

/** Characters a tree takes on the wire, by the same count as the limit. */
export function clientScreenFrameSize(root: ClientScreenFrameNode): { nodes: number; chars: number } {
  const size = { nodes: 0, chars: 0 };
  const stack: ClientScreenFrameNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    size.nodes += 1;
    if (typeof node === 'string') {
      size.chars += node.length;
      continue;
    }
    for (const [name, value] of Object.entries(node.a ?? {})) size.chars += name.length + value.length;
    for (const child of node.c ?? []) stack.push(child);
  }
  return size;
}
