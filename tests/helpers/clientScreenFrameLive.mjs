// Browser-side readers for the live check of tabs shown whole. Each runs inside a page.

const CONTROL = '.ant-table, .ant-btn, .ant-card, .ant-empty, .ant-tag, .ant-input, .ant-select, img, canvas, svg, h1, h2, h3, h4, h5, [class*="sticky"], [class*="cut-"]';

/** In the manager window: what the tab shows. */
export function readManagerTab([tab, selector]) {
  // (Each reader carries its own copy of this helper: a reader is sent to the page alone.)
  // What is really on the glass at a few points of the tab: the element there and how see-through it
  // and its ancestors are. Equal boxes do not prove a tab is visible — something may cover or fade it.
  function seenAt(doc, node, origin) {
    const points = [[0.1, 30], [0.5, 60], [0.9, 30], [0.3, 140], [0.7, 220]];
    return points.map(([share, down]) => {
      const element = doc.elementFromPoint(origin.left + origin.width * share, origin.top + down);
      if (!element || !node.contains(element)) return 'outside the tab';
      let opacity = 1;
      let hidden = false;
      for (let current = element; current && current !== node.parentElement; current = current.parentElement) {
        const style = doc.defaultView.getComputedStyle(current);
        opacity *= Number(style.opacity);
        if (style.visibility === 'hidden') hidden = true;
      }
      const cls = (element.getAttribute('class') ?? '').split(' ')[0];
      return `${element.tagName.toLowerCase()}.${cls} ${hidden ? 'hidden' : `opacity ${Math.round(opacity * 100) / 100}`}`;
    });
  }
  const node = document.querySelector(`[data-client-screen-frame="${tab}"]`);
  if (!node) return null;
  const origin = node.getBoundingClientRect();
  const clone = node.cloneNode(true);
  clone.querySelectorAll('script, style, noscript, template').forEach((element) => element.remove());
  return {
    width: Math.round(origin.width),
    viewport: [window.innerWidth, window.innerHeight],
    text: clone.textContent,
    images: node.querySelectorAll('img, canvas').length,
    controls: [...node.querySelectorAll(selector)].slice(0, 400).map((element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(), cls: typeof element.className === 'string' ? element.className : '',
        x: Math.round(box.left - origin.left), y: Math.round(box.top - origin.top), w: Math.round(box.width), h: Math.round(box.height),
        color: style.color, font: `${style.fontSize} ${style.fontWeight} ${style.fontFamily}`, position: style.position,
      };
    }),
    timings: performance.getEntriesByName('client-screen-frame-copy').map((entry) => Math.round(entry.duration)),
    seen: seenAt(document, node, origin),
  };
}

/** In the window that draws the copy (the customer window, or the manager window for the miniature). */
export function readCopy([scope, selector]) {
  // (Each reader carries its own copy of this helper: a reader is sent to the page alone.)
  // What is really on the glass at a few points of the tab: the element there and how see-through it
  // and its ancestors are. Equal boxes do not prove a tab is visible — something may cover or fade it.
  function seenAt(doc, node, origin) {
    const points = [[0.1, 30], [0.5, 60], [0.9, 30], [0.3, 140], [0.7, 220]];
    return points.map(([share, down]) => {
      const element = doc.elementFromPoint(origin.left + origin.width * share, origin.top + down);
      if (!element || !node.contains(element)) return 'outside the tab';
      let opacity = 1;
      let hidden = false;
      for (let current = element; current && current !== node.parentElement; current = current.parentElement) {
        const style = doc.defaultView.getComputedStyle(current);
        opacity *= Number(style.opacity);
        if (style.visibility === 'hidden') hidden = true;
      }
      const cls = (element.getAttribute('class') ?? '').split(' ')[0];
      return `${element.tagName.toLowerCase()}.${cls} ${hidden ? 'hidden' : `opacity ${Math.round(opacity * 100) / 100}`}`;
    });
  }
  const box = document.querySelector(`${scope} iframe.client-screen__frame-box`);
  const doc = box?.contentDocument;
  const node = doc?.querySelector('[data-cs-tab]');
  if (!box || !doc || !node) return null;
  const origin = node.getBoundingClientRect();
  const handlers = [...doc.querySelectorAll('*')].filter((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name))).length;
  const addressed = [...doc.querySelectorAll('[src], [href], [srcset], [action], [formaction], [background], [poster]')]
    .map((element) => element.getAttribute('src') ?? element.getAttribute('href') ?? element.getAttribute('srcset') ?? 'other')
    .filter((value) => !value.startsWith('data:image/') && !value.startsWith('#'));
  const images = [...doc.querySelectorAll('img')];
  // Where the tab lands in the window that draws it: the box is shifted and scaled, and cut by its holder.
  const matrix = new DOMMatrixReadOnly(getComputedStyle(box).transform);
  // Layout sizes, not what is on the glass: the miniature shows the same page scaled down as a whole.
  const holder = { width: box.parentElement.clientWidth, height: box.parentElement.clientHeight };
  const place = {
    left: Math.round(origin.left * matrix.a + matrix.e), top: Math.round(origin.top * matrix.a + matrix.f),
    bottom: Math.round((origin.top + origin.height) * matrix.a + matrix.f), right: Math.round((origin.left + origin.width) * matrix.a + matrix.e),
    holderWidth: Math.round(holder.width), holderHeight: Math.round(holder.height), scale: Math.round(matrix.a * 1000) / 1000,
    inner: `${Math.round(origin.left)},${Math.round(origin.top)} ${Math.round(origin.width)}x${Math.round(origin.height)}`,
  };
  return {
    place,
    // The node of the tab stays the same node while the copy is only brought up to date.
    sameNode: (node.__seen = (node.__seen ?? 0) + 1),
    seen: seenAt(doc, node, origin),
    sandbox: box.getAttribute('sandbox'),
    policy: doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? null,
    policyFirst: doc.head.firstElementChild?.getAttribute('http-equiv') === 'Content-Security-Policy',
    scripts: doc.querySelectorAll('script, iframe, object, embed, link, base, form').length,
    handlers,
    addressed,
    width: Math.round(origin.width),
    viewport: [box.clientWidth, box.clientHeight],
    scrollTop: Math.round(doc.defaultView?.scrollY ?? 0),
    text: node.textContent,
    images: images.length,
    brokenImages: images.filter((image) => image.hasAttribute('src') && !(image.complete && image.naturalWidth > 0)).length,
    emptyImages: images.filter((image) => !image.hasAttribute('src')).length,
    controls: [...node.querySelectorAll(selector)].slice(0, 400).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = doc.defaultView.getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(), cls: element.getAttribute('class') ?? '',
        x: Math.round(rect.left - origin.left), y: Math.round(rect.top - origin.top), w: Math.round(rect.width), h: Math.round(rect.height),
        color: style.color, font: `${style.fontSize} ${style.fontWeight} ${style.fontFamily}`, position: style.position,
      };
    }),
  };
}

export const FRAME_CONTROL_SELECTOR = CONTROL;
