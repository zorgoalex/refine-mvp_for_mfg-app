import { describe, expect, it } from 'vitest';
import {
  CLIENT_SCREEN_FRAME_LIMITS,
  cleanClientScreenFrameTree,
  clientScreenFrameAttribute,
  clientScreenFrameSize,
  clientScreenFrameTag,
  type ClientScreenFrameElement,
} from './clientScreenFrameTree';

const div = (a?: Record<string, string>, c?: unknown[]): unknown => ({ t: 'div', ...(a ? { a } : {}), ...(c ? { c } : {}) });

describe('frame tree: tags', () => {
  it('keeps ordinary markup, lower-cases HTML, keeps SVG names as written', () => {
    expect(clientScreenFrameTag('DIV', false)).toEqual({ t: 'div' });
    expect(clientScreenFrameTag('TABLE', false)).toEqual({ t: 'table' });
    expect(clientScreenFrameTag('linearGradient', true)).toEqual({ t: 'linearGradient', s: 1 });
  });

  it('drops with everything inside what runs, loads or navigates', () => {
    for (const tag of ['script', 'SCRIPT', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'template', 'noscript', 'video', 'audio']) {
      expect(clientScreenFrameTag(tag, false), tag).toBeNull();
    }
    for (const tag of ['script', 'foreignObject', 'animate', 'set', 'animateTransform', 'style']) {
      expect(clientScreenFrameTag(tag, true), tag).toBeNull();
    }
  });

  it('draws a form as a box and an unknown element as a neutral one', () => {
    expect(clientScreenFrameTag('FORM', false)).toEqual({ t: 'div' });
    expect(clientScreenFrameTag('my-widget', false)).toEqual({ t: 'span' });
    expect(clientScreenFrameTag('a', true)).toEqual({ t: 'g', s: 1 });
    expect(clientScreenFrameTag('bad tag', false)).toBeNull();
  });
});

describe('frame tree: attributes', () => {
  it('keeps what only draws', () => {
    expect(clientScreenFrameAttribute('div', false, 'class', 'ant-table')).toBe('ant-table');
    expect(clientScreenFrameAttribute('div', false, 'style', 'width: 10px; color: red')).toBe('width: 10px; color: red');
    expect(clientScreenFrameAttribute('div', false, 'data-row-key', '5')).toBe('5');
    expect(clientScreenFrameAttribute('td', false, 'colspan', '2')).toBe('2');
    expect(clientScreenFrameAttribute('path', true, 'd', 'M0 0L1 1')).toBe('M0 0L1 1');
    expect(clientScreenFrameAttribute('svg', true, 'viewBox', '0 0 10 10')).toBe('0 0 10 10');
  });

  it('never keeps an event handler, whatever the case', () => {
    for (const name of ['onclick', 'onerror', 'ONLOAD', 'onMouseOver', 'onbegin']) {
      expect(clientScreenFrameAttribute('img', false, name, 'alert(1)'), name).toBeNull();
      expect(clientScreenFrameAttribute('svg', true, name, 'alert(1)'), name).toBeNull();
    }
  });

  it('keeps no link of an HTML element and only in-page references in SVG', () => {
    expect(clientScreenFrameAttribute('a', false, 'href', '/orders')).toBeNull();
    expect(clientScreenFrameAttribute('a', false, 'href', 'javascript:alert(1)')).toBeNull();
    expect(clientScreenFrameAttribute('use', true, 'href', '#sheet-1')).toBe('#sheet-1');
    expect(clientScreenFrameAttribute('use', true, 'xlink:href', 'https://evil.example/x.svg#a')).toBeNull();
    expect(clientScreenFrameAttribute('use', true, 'href', 'javascript:alert(1)')).toBeNull();
    expect(clientScreenFrameAttribute('g', true, 'href', '#a')).toBeNull();
  });

  it('lets a picture be only an inline raster image: nothing with an address', () => {
    const keep = ['data:image/png;base64,AAAA', 'data:image/webp;base64,UklGRg==', 'data:image/jpeg;base64,/9j/4A=='];
    for (const value of keep) expect(clientScreenFrameAttribute('img', false, 'src', value), value).toBe(value);
    const drop = [
      'https://evil.example/a.png', '//evil.example/a.png', '/\\evil.example', 'javascript:alert(1)', 'data:text/html,<script>',
      'data:image/png;base64,AA"onerror="x', '/api/v1/orders/1', '/assets/a.png', 'blob:https://app-test.mebelkz.app/1b2c',
      'data:image/svg+xml,%3Csvg%3E', 'data:image/svg+xml;base64,AAAA', 'data:image/png,raw',
    ];
    for (const value of drop) expect(clientScreenFrameAttribute('img', false, 'src', value), value).toBeNull();
    expect(clientScreenFrameAttribute('div', false, 'src', 'data:image/png;base64,AAAA')).toBeNull();
    expect(clientScreenFrameAttribute('image', true, 'href', 'data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(clientScreenFrameAttribute('image', true, 'href', 'blob:https://app-test.mebelkz.app/1')).toBeNull();
    expect(clientScreenFrameAttribute('image', true, 'href', '/api/v1/files/1')).toBeNull();
  });

  it('drops a style that reaches outside or runs something', () => {
    for (const value of [
      'background: url(https://evil.example/a.png)', 'background: url("//evil.example/a")', 'width: expression(alert(1))',
      'background: url(javascript:alert(1))', '@import "x.css"', 'behavior: url(x.htc)', 'background: url(/api/v1/orders/1)',
      'background: url("/assets/a.png")', 'background: url(blob:https://app-test.mebelkz.app/1)', 'background: url(data:image/svg+xml,x)',
      'background: image-set("/api/x" 1x)', 'background: u\\72l(/api/x)', 'background: URL( "/api/x" )',
    ]) {
      expect(clientScreenFrameAttribute('div', false, 'style', value), value).toBeNull();
    }
    expect(clientScreenFrameAttribute('div', false, 'style', 'background: url(data:image/png;base64,AA==)')).not.toBeNull();
    expect(clientScreenFrameAttribute('div', false, 'style', 'a: url(data:image/png;base64,AA==); b: url(/api/x)')).toBeNull();
    expect(clientScreenFrameAttribute('rect', true, 'fill', 'url(#grad)')).toBe('url(#grad)');
    expect(clientScreenFrameAttribute('rect', true, 'fill', 'url(https://evil.example/x.svg#a)')).toBeNull();
  });

  it('keeps nothing that submits, embeds, edits or takes focus', () => {
    for (const name of ['action', 'formaction', 'srcdoc', 'srcset', 'contenteditable', 'autofocus', 'tabindex', 'target', 'download', 'ping', 'name', 'http-equiv', 'background', 'poster']) {
      expect(clientScreenFrameAttribute('div', false, name, 'x'), name).toBeNull();
    }
    expect(clientScreenFrameAttribute('input', false, 'type', 'password')).toBe('text');
    expect(clientScreenFrameAttribute('input', false, 'type', 'file')).toBe('text');
    expect(clientScreenFrameAttribute('input', false, 'type', 'CHECKBOX')).toBe('checkbox');
  });
});

describe('frame tree: the check on the customer side', () => {
  it('returns a clean copy of a good tree', () => {
    const tree = div({ class: 'cut-page' }, ['Задания', { t: 'svg', s: 1, a: { viewBox: '0 0 1 1' }, c: [{ t: 'rect', s: 1, a: { width: '1' } }] }]);
    expect(cleanClientScreenFrameTree(tree)).toEqual(tree);
  });

  it('removes what the rules forbid even if the sender did not', () => {
    const cleaned = cleanClientScreenFrameTree(div({ onclick: 'x()', class: 'a' }, [
      { t: 'script', c: ['alert(1)'] },
      { t: 'img', a: { src: 'https://evil.example/a.png', srcset: '/api/v1/x 1x', onerror: 'x()', alt: 'лист' } },
      { t: 'a', a: { href: 'javascript:alert(1)' }, c: ['ссылка'] },
      { t: 'svg', s: 1, c: [{ t: 'foreignObject', s: 1, c: [{ t: 'iframe', s: 1 }] }, { t: 'script', s: 1, c: ['x'] }] },
    ]));
    expect(cleaned).toEqual({
      t: 'div', a: { class: 'a' },
      c: [{ t: 'img', a: { alt: 'лист' } }, { t: 'a', c: ['ссылка'] }, { t: 'svg', s: 1 }],
    });
    expect(JSON.stringify(cleaned)).not.toMatch(/script|onerror|onclick|javascript|iframe|evil/);
  });

  it('refuses a tree that claims SVG outside an SVG root or HTML inside one', () => {
    expect(cleanClientScreenFrameTree(div(undefined, [{ t: 'script', s: 1 }]))).toBeNull();
    expect(cleanClientScreenFrameTree(div(undefined, [{ t: 'path', s: 1 }]))).toBeNull();
    expect(cleanClientScreenFrameTree(div(undefined, [{ t: 'svg', s: 1, c: [{ t: 'div' }] }]))).toBeNull();
  });

  it('refuses what is not a tree', () => {
    for (const bad of [null, 'text', 5, [], { t: 5 }, { t: 'div', a: [] }, { t: 'div', a: { class: 5 } }, { t: 'div', c: 'x' }, { t: 'div', c: [5] }, { t: 'div', s: 2 }]) {
      expect(cleanClientScreenFrameTree(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(cleanClientScreenFrameTree({ t: 'script' })).toBeNull();
  });

  it('refuses an oversized tree whole instead of cutting it', () => {
    const many = div(undefined, Array.from({ length: CLIENT_SCREEN_FRAME_LIMITS.nodes }, () => 'x'));
    expect(cleanClientScreenFrameTree(many)).toBeNull();
    expect(cleanClientScreenFrameTree(div(undefined, ['x'.repeat(CLIENT_SCREEN_FRAME_LIMITS.chars + 1)]))).toBeNull();
    let deep: unknown = div();
    for (let i = 0; i < CLIENT_SCREEN_FRAME_LIMITS.depth + 2; i += 1) deep = div(undefined, [deep]);
    expect(cleanClientScreenFrameTree(deep)).toBeNull();
    const wide: Record<string, string> = {};
    for (let i = 0; i <= CLIENT_SCREEN_FRAME_LIMITS.attributes; i += 1) wide[`data-a${i}`] = '1';
    expect(cleanClientScreenFrameTree(div(wide))).toBeNull();
  });

  it('counts a tree the way the limit does', () => {
    const tree = cleanClientScreenFrameTree(div({ class: 'ab' }, ['xyz', { t: 'span' }])) as ClientScreenFrameElement;
    expect(clientScreenFrameSize(tree)).toEqual({ nodes: 3, chars: 5 + 2 + 3 });
  });
});
