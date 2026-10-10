// Browser-side readers for the live check of tabs shown whole. Each runs inside a page.

const CONTROL = '.ant-table, .ant-btn, .ant-card, .ant-empty, .ant-tag, .ant-input, .ant-select, img, canvas, svg, h1, h2, h3, h4, h5, [class*="sticky"], [class*="cut-"]';

/** In the manager window: what the tab shows. */
export function readManagerTab([tab, selector]) {
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
  };
}

/** In the window that draws the copy (the customer window, or the manager window for the miniature). */
export function readCopy([scope, selector]) {
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
  return {
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
