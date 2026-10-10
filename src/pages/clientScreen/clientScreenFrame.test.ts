import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClientScreenSnapshot, createClientScreenIdMap, filterClientScreenUi, resolveClientScreenTab, withShownFrameOnly, type ClientScreenOrderSource } from './buildClientScreenSnapshot';
import {
  captureClientScreenFrame, captureFrameStyles, captureFrameSurroundings, CLIENT_SCREEN_FRAME_SCROLL_ATTRIBUTE, CLIENT_SCREEN_FRAME_STYLE_LIMITS,
  type FrameSourceElement, type FrameSourceNode,
} from './clientScreenFrameCapture';
import { clientScreenFrameWindow } from './clientScreenFrameLayout';
import { createClientScreenFrameSource, FRAME_CAPTURE_MS } from './clientScreenFrameSource';
import { createClientScreenFrameKeeper, FRAME_KEEPER_CHECK_MS, keepsClientScreenFrame, type FrameTick } from './clientScreenFrameKeeper';
import { CLIENT_SCREEN_FRAME_LIMITS } from './clientScreenFrameTree';
import { CLIENT_SCREEN_CODES, CLIENT_SCREEN_DEFAULT_VISIBLE_CODES } from './clientScreenRegistry';
import { clientScreenFrameSchema, clientScreenSnapshotSchema, clientScreenUiSchema, type ClientScreenFrame, type ClientScreenUi } from './clientScreenSnapshotSchema';
import { buildMirrorView } from './mirrorView';

const SVG = 'http://www.w3.org/2000/svg';
const text = (value: string): FrameSourceNode => ({ nodeType: 3, nodeValue: value });
function el(tagName: string, attributes: Record<string, string> = {}, children: FrameSourceNode[] = [], extra: Partial<FrameSourceElement> = {}): FrameSourceElement {
  return {
    nodeType: 1, tagName, namespaceURI: 'http://www.w3.org/1999/xhtml',
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })), childNodes: children, ...extra,
  };
}
const svg = (tagName: string, attributes: Record<string, string> = {}, children: FrameSourceNode[] = []) => el(tagName, attributes, children, { namespaceURI: SVG });
const noImages = () => null;
const PIXEL = 'data:image/webp;base64,UklGRg==';

describe('whole-tab copy: reading the manager\'s tab', () => {
  it('copies markup, texts and drawings, and nothing that runs, links or loads', () => {
    const root = el('DIV', { class: 'cut-page', onclick: 'x()' }, [
      el('H3', {}, [text('Задания')]),
      el('A', { href: '/orders/5', class: 'link' }, [text('Заказ 5')]),
      el('SCRIPT', {}, [text('alert(1)')]),
      el('STYLE', {}, [text('.a{background:url(/api/x)}')]),
      el('IFRAME', { src: '/api/x' }),
      el('DIV', { style: 'background: url(/api/v1/files/1)' }, [text('фон')]),
      svg('svg', { viewBox: '0 0 10 10' }, [svg('rect', { width: '5', onload: 'x()' }), svg('foreignObject', {}, [el('DIV', {}, [text('внутри')])]), svg('use', { href: '/sprite.svg#a' })]),
      { nodeType: 8, nodeValue: 'comment' },
    ]);
    const { tree } = captureClientScreenFrame(root, noImages);
    expect(tree).toEqual({
      t: 'div', a: { class: 'cut-page' },
      c: [
        { t: 'h3', c: ['Задания'] },
        { t: 'a', a: { class: 'link' }, c: ['Заказ 5'] },
        { t: 'div', c: ['фон'] },
        { t: 'svg', s: 1, a: { viewBox: '0 0 10 10' }, c: [{ t: 'rect', s: 1, a: { width: '5' } }, { t: 'use', s: 1 }] },
      ],
    });
    expect(JSON.stringify(tree)).not.toMatch(/script|alert|onclick|onload|href|\/api\/|iframe|comment|внутри/);
    // What was read is exactly what the receiving side accepts: nothing more to clean.
    expect(clientScreenFrameSchema.shape.tree.parse(tree)).toEqual(tree);
  });

  it('carries a picture inside the copy: no address of the manager\'s page survives', () => {
    const root = el('DIV', {}, [
      el('IMG', { src: 'blob:https://app-test.mebelkz.app/1b2c', alt: 'Лист 1', class: 'app-image-outline', srcset: '/api/x 2x', onerror: 'x()' }),
      el('IMG', { src: '/api/v1/files/7', alt: 'ещё не загружена' }),
      el('CANVAS', { width: '10', height: '10', class: 'label' }),
    ]);
    const seen: string[] = [];
    const { tree } = captureClientScreenFrame(root, (element) => {
      seen.push(element.tagName);
      return element.attributes[0]?.value.startsWith('/api/') ? null : PIXEL;
    });
    expect(seen).toEqual(['IMG', 'IMG', 'CANVAS']);
    expect(tree?.c).toEqual([
      { t: 'img', a: { alt: 'Лист 1', class: 'app-image-outline', src: PIXEL } },
      // Not loaded yet: an empty box, never the address.
      { t: 'img', a: { alt: 'ещё не загружена' } },
      { t: 'img', a: { width: '10', height: '10', class: 'label', src: PIXEL } },
    ]);
    expect(JSON.stringify(tree)).not.toMatch(/blob:|\/api\//);
    // An encoder that hands back an address or throws gives an empty box as well.
    expect(captureClientScreenFrame(el('DIV', {}, [el('IMG', { src: 'x' })]), () => '/api/v1/files/7').tree?.c).toEqual([{ t: 'img', a: {} }]);
    expect(captureClientScreenFrame(el('DIV', {}, [el('IMG', { src: 'x' })]), () => { throw new Error('tainted'); }).tree?.c).toEqual([{ t: 'img', a: {} }]);
  });

  it('shows form controls with what is in them right now, and never a password or a file', () => {
    const root = el('DIV', {}, [
      el('INPUT', { type: 'text', value: 'было' }, [], { type: 'text', value: 'стало' }),
      el('INPUT', { type: 'checkbox' }, [], { type: 'checkbox', checked: true }),
      el('INPUT', { type: 'checkbox', checked: '' }, [], { type: 'checkbox', checked: false }),
      el('INPUT', { type: 'password', value: 'secret' }, [], { type: 'password', value: 'secret' }),
      el('INPUT', { type: 'file' }, [], { type: 'file', value: 'C:\\fakepath\\a.pdf' }),
      el('TEXTAREA', {}, [text('старый текст')], { value: 'новый текст' }),
      el('SELECT', {}, [el('OPTION', { value: '1', selected: '' }, [text('Один')], { selected: false }), el('OPTION', { value: '2' }, [text('Два')], { selected: true })]),
    ]);
    expect(captureClientScreenFrame(root, noImages).tree?.c).toEqual([
      { t: 'input', a: { type: 'text', value: 'стало' } },
      { t: 'input', a: { type: 'checkbox', checked: '' } },
      { t: 'input', a: { type: 'checkbox' } },
      { t: 'input', a: { type: 'text' } },
      { t: 'input', a: { type: 'text' } },
      { t: 'textarea', c: ['новый текст'] },
      { t: 'select', c: [{ t: 'option', a: { value: '1' }, c: ['Один'] }, { t: 'option', a: { value: '2', selected: '' }, c: ['Два'] }] },
    ]);
  });

  it('remembers how far an inner area is scrolled', () => {
    const root = el('DIV', {}, [el('DIV', { class: 'list' }, [text('x')], { scrollTop: 120.4, scrollLeft: 0 })]);
    expect(captureClientScreenFrame(root, noImages).tree?.c).toEqual([{ t: 'div', a: { class: 'list', [CLIENT_SCREEN_FRAME_SCROLL_ATTRIBUTE]: '120,0' }, c: ['x'] }]);
  });

  it('a tab over the limit is reported whole as too large, never cut', () => {
    const many = el('DIV', {}, Array.from({ length: CLIENT_SCREEN_FRAME_LIMITS.nodes + 1 }, () => text('x')));
    expect(captureClientScreenFrame(many, noImages).tree).toBeNull();
    const heavy = el('DIV', {}, Array.from({ length: 9 }, () => el('IMG', { src: 'x' })));
    const megabyte = `data:image/webp;base64,${'A'.repeat(1_000_000)}`;
    expect(captureClientScreenFrame(heavy, () => megabyte).tree).toBeNull();
    expect(captureClientScreenFrame(el('DIV', {}, [el('IMG', { src: 'x' })]), () => megabyte).tree).not.toBeNull();
  });
});

describe('whole-tab copy: what the tab\'s styles need from outside it', () => {
  const node = (tagName: string, cls: string, attributes: Record<string, string>, parentElement: unknown = null) => ({
    tagName, className: cls, parentElement: parentElement as never,
    attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
    getAttribute: (name: string) => attributes[name] ?? null,
  });

  it('takes the chain of ancestors with classes, data attributes and inline variables, and the theme of the page', () => {
    const html = node('HTML', 'theme-light', { 'data-ui-variant': 'workbench', style: '--app-surface: #fff', lang: 'ru' });
    const body = node('BODY', 'app', { 'data-theme': 'light' }, html);
    const layout = node('MAIN', 'evo-layout', { style: 'margin-left: 224px; background: url(/api/x)', id: 'main' }, body);
    const form = node('FORM', 'order-form', { style: '--wb-order-sticky-top: 132px', 'data-order': '5', onsubmit: 'x()' }, layout);
    const pane = node('DIV', 'ant-tabs-tabpane', { role: 'tabpanel' }, form);
    const tab = node('DIV', '', { 'data-client-screen-frame': 'cut' }, pane);
    expect(captureFrameSurroundings(tab, html, body)).toEqual({
      shells: [
        // A style that reaches for an address is left out whole.
        { tag: 'main', cls: 'evo-layout', data: {}, style: '' },
        { tag: 'div', cls: 'order-form', data: { 'data-order': '5' }, style: '--wb-order-sticky-top: 132px' },
        { tag: 'div', cls: 'ant-tabs-tabpane', data: {}, style: '' },
      ],
      root: { htmlCls: 'theme-light', bodyCls: 'app', htmlData: { 'data-ui-variant': 'workbench' }, bodyData: { 'data-theme': 'light' }, htmlStyle: '--app-surface: #fff', bodyStyle: '' },
    });
  });

  it('takes the styles of the page as text; unreadable or oversized styles mean no copy at all', () => {
    const sheet = (...rules: string[]) => ({ cssRules: rules.map((cssText) => ({ cssText })) });
    expect(captureFrameStyles([sheet('.a { color: red; }', '.b { top: var(--x); }'), sheet(), sheet('.c { }')])).toEqual(['.a { color: red; }\n.b { top: var(--x); }\n', '.c { }\n']);
    expect(captureFrameStyles([{ get cssRules(): never { throw new Error('cross-origin'); } }])).toBeNull();
    expect(captureFrameStyles([sheet('x'.repeat(CLIENT_SCREEN_FRAME_STYLE_LIMITS.chars + 1))])).toBeNull();
  });
});

describe('whole-tab copy: where it stands on the customer\'s screen', () => {
  const frame = { viewport: { w: 1500, h: 900 }, port: { w: 1500, h: 900 }, left: 240, top: 300, width: 1200, height: 2000 };

  it('shows only the tab, scaled to the width at hand', () => {
    expect(clientScreenFrameWindow(frame, 0, 1800)).toEqual({
      scale: 1.5, scrollTop: 0, shiftX: -360, shiftY: -450, shownWidth: 1800, shownHeight: 900, pageHeight: 3200,
    });
  });

  it('follows the manager\'s scroll: the part of the tab in sight, from the top of the area once the tab reaches it', () => {
    expect(clientScreenFrameWindow(frame, 200, 1200)).toMatchObject({ scale: 1, scrollTop: 200, shiftY: -100, shownHeight: 800 });
    expect(clientScreenFrameWindow(frame, 1000, 1200)).toMatchObject({ scrollTop: 1000, shiftY: -0, shownHeight: 900 });
    // The end of the tab is in sight: only what is left of it.
    expect(clientScreenFrameWindow(frame, 2000, 1200)).toMatchObject({ scrollTop: 2000, shownHeight: 300 });
  });

  it('a tab scrolled out of the manager\'s sight is still shown: its nearest end, never an empty area', () => {
    // The tab is far below the manager's window (a long one-page form scrolled to its top): its beginning.
    const low = { ...frame, top: 2340 };
    expect(clientScreenFrameWindow(low, 0, 1200)).toMatchObject({ scrollTop: 2340, shiftY: -0, shownHeight: 900 });
    expect(clientScreenFrameWindow(low, 1500, 1200)).toMatchObject({ scrollTop: 2340, shownHeight: 900 });
    // Enough of it has come into sight: exactly what the manager sees.
    expect(clientScreenFrameWindow(low, 1700, 1200)).toMatchObject({ scrollTop: 1700, shiftY: -640, shownHeight: 260 });
    // The manager has scrolled past the tab: its end.
    expect(clientScreenFrameWindow(frame, 2250, 1200)).toMatchObject({ scrollTop: 1400, shownHeight: 900 });
    expect(clientScreenFrameWindow(frame, 99_999, 1200)).toMatchObject({ scrollTop: 1400, shownHeight: 900 });
    // A short tab is shown whole.
    expect(clientScreenFrameWindow({ ...frame, top: 2340, height: 120 }, 0, 1200)).toMatchObject({ scrollTop: 2340, shownHeight: 120 });
  });

  it('a tab inside a scrolled panel is cut by that panel, not by the window', () => {
    const inPanel = { ...frame, port: { w: 1260, h: 600 }, left: 0, top: 0 };
    expect(clientScreenFrameWindow(inPanel, 0, 1200)).toMatchObject({ shiftX: -0, shiftY: -0, shownHeight: 600 });
    expect(clientScreenFrameWindow({ ...inPanel, height: 250 }, 0, 1200)).toMatchObject({ shownHeight: 250 });
    expect(clientScreenFrameWindow(inPanel, 0, 0).scale).toBe(1);
  });
});

const goodFrame = (over: Partial<ClientScreenFrame> = {}): ClientScreenFrame => ({
  tab: 'cut', viewport: { w: 1500, h: 900 }, port: { w: 1500, h: 900 }, left: 240, top: 300, width: 1200, height: 700,
  tree: { t: 'div', a: { class: 'cut-page' }, c: ['Задание 1'] },
  shells: [{ tag: 'div', cls: 'order-form', data: { 'data-order': '5' }, style: '--wb-order-sticky-top: 132px' }],
  root: { htmlCls: 'a', bodyCls: 'b', htmlData: { 'data-ui-variant': 'workbench' }, bodyData: {}, htmlStyle: '', bodyStyle: '' },
  styles: ['.cut-page { color: red; }'],
  ...over,
});

describe('whole-tab copy: on the wire', () => {
  it('accepts a copy and cleans its tree again on arrival', () => {
    expect(clientScreenFrameSchema.parse(goodFrame())).toEqual(goodFrame());
    const dirty = { ...goodFrame(), tree: { t: 'div', a: { onclick: 'x()' }, c: [{ t: 'script', c: ['x'] }, { t: 'img', a: { src: '/api/v1/x' } }, 'текст'] } };
    expect(clientScreenFrameSchema.parse(dirty).tree).toEqual({ t: 'div', c: [{ t: 'img' }, 'текст'] });
    expect(clientScreenFrameSchema.parse({ ...goodFrame(), tree: null }).tree).toBeNull();
  });

  it('drops a copy that is not one', () => {
    const bad: unknown[] = [
      { ...goodFrame(), tree: 'text' }, { ...goodFrame(), tree: { t: 5 } }, { ...goodFrame(), tab: 'details' }, { ...goodFrame(), width: 0 },
      { ...goodFrame(), extra: 1 }, { ...goodFrame(), viewport: { w: 1500 } },
      { ...goodFrame(), shells: [{ tag: 'script', cls: '', data: {}, style: '' }] },
      { ...goodFrame(), shells: [{ tag: 'div', cls: '', data: { onclick: 'x' }, style: '' }] },
      { ...goodFrame(), shells: [{ tag: 'div', cls: '', data: {}, style: 'background: url(/api/v1/x)' }] },
      { ...goodFrame(), root: { ...goodFrame().root, htmlStyle: 'background: url(https://evil.example/a.png)' } },
      { ...goodFrame(), root: { ...goodFrame().root, bodyData: { href: 'x' } } },
      { ...goodFrame(), styles: ['x'.repeat(4_000_001)] },
      { ...goodFrame(), styles: ['x'.repeat(2_100_000), 'x'.repeat(2_100_000)] },
    ];
    for (const frame of bad) expect(clientScreenFrameSchema.safeParse(frame).success, JSON.stringify(frame).slice(0, 200)).toBe(false);
  });

  it('the scroll offset of the copy is a small number in the interface state', () => {
    const ui = { tab: 'cut', focus: null, editing: null, scroll: { ratio: 0, frameTop: 340 }, page: null };
    expect(clientScreenUiSchema.parse(ui)).toEqual(ui);
    expect(clientScreenUiSchema.safeParse({ ...ui, scroll: { ratio: 0, frameTop: -1 } }).success).toBe(false);
    expect(clientScreenUiSchema.safeParse({ ...ui, scroll: { ratio: 0, frameTop: 1.5 } }).success).toBe(false);
  });
});

describe('whole-tab copy: only with the tick of that tab', () => {
  const source = (over: Partial<ClientScreenOrderSource> = {}): ClientScreenOrderSource => ({
    tabs: [{ key: 'basic', label: 'Основная информация' }, { key: 'cut', label: 'Раскрой' }, { key: 'workshops', label: 'Цеха' }, { key: 'additional', label: 'Дополнительно' }],
    summary: { number: '17' }, basic: { order_name: 'К-1' }, dates: {}, finance: {}, payments: [],
    details: { columnOrder: [], rows: [], grouping: null }, services: [],
    ...over,
  });
  const ids = () => createClientScreenIdMap(() => 'idaaaaaa');

  it('the three tabs are off by default and have no field codes', () => {
    for (const code of ['tab.cut', 'tab.workshops', 'tab.additional']) {
      expect(CLIENT_SCREEN_CODES).toContain(code);
      expect(CLIENT_SCREEN_DEFAULT_VISIBLE_CODES).not.toContain(code);
    }
    const byDefault = buildClientScreenSnapshot(source({ frame: goodFrame() }), CLIENT_SCREEN_DEFAULT_VISIBLE_CODES, ids());
    expect(byDefault.tabs.map((tab) => tab.key)).toEqual(['basic']);
    expect(byDefault.frame).toBeUndefined();
    expect(JSON.stringify(byDefault)).not.toContain('Задание 1');
  });

  it('a ticked tab is listed and its copy goes; another tab\'s tick does not let it through', () => {
    const withCut = buildClientScreenSnapshot(source({ frame: goodFrame() }), ['summary.number', 'tab.basic', 'tab.cut'], ids());
    expect(withCut.tabs.map((tab) => tab.key)).toEqual(['basic', 'cut']);
    expect(withCut.frame).toEqual(goodFrame());
    expect(clientScreenSnapshotSchema.safeParse(withCut).success).toBe(true);
    const otherTick = buildClientScreenSnapshot(source({ frame: goodFrame() }), ['tab.basic', 'tab.additional', 'tab.workshops'], ids());
    expect(otherTick.tabs.map((tab) => tab.key)).toEqual(['basic', 'workshops', 'additional']);
    expect(otherTick.frame).toBeUndefined();
    // A manager whose form has no cut tab: the tick alone shows nothing.
    const noTab = buildClientScreenSnapshot(source({ tabs: [{ key: 'basic', label: 'Основная информация' }], frame: goodFrame() }), CLIENT_SCREEN_CODES, ids());
    expect(noTab.frame).toBeUndefined();
    expect(noTab.tabs.map((tab) => tab.key)).toEqual(['basic']);
  });

  it('the copy travels only while the customer is on that tab, and is kept for the tab the customer stays on', () => {
    const snapshot = buildClientScreenSnapshot(source({ frame: goodFrame() }), ['tab.basic', 'tab.cut'], ids());
    expect(withShownFrameOnly(snapshot, 'cut')).toBe(snapshot);
    expect(withShownFrameOnly(snapshot, 'basic').frame).toBeUndefined();
    expect(withShownFrameOnly(snapshot, 'basic').tabs).toEqual(snapshot.tabs);
    expect(withShownFrameOnly(snapshot, null).frame).toBeUndefined();
    // The manager went to a tab the customer does not see (additional is not ticked): the customer stays on cut, with its copy.
    const stays = resolveClientScreenTab('additional', 'cut', snapshot);
    expect(stays).toBe('cut');
    expect(withShownFrameOnly(snapshot, stays).frame).toEqual(goodFrame());
    // …and went on to a tab the customer does see: the copy stops travelling.
    expect(withShownFrameOnly(snapshot, resolveClientScreenTab('basic', 'cut', snapshot)).frame).toBeUndefined();
  });

  it('the scroll offset goes only next to the copy it belongs to', () => {
    const snapshot = buildClientScreenSnapshot(source({ frame: goodFrame() }), ['tab.basic', 'tab.cut'], ids());
    const ui = (tab: ClientScreenUi['tab']): ClientScreenUi => ({ tab, focus: null, editing: null, scroll: { ratio: 0.5, frameTop: 340 }, page: null });
    expect(filterClientScreenUi(ui('cut'), snapshot, ['tab.basic', 'tab.cut']).scroll).toEqual({ ratio: 0.5, frameTop: 340 });
    expect(filterClientScreenUi(ui('basic'), snapshot, ['tab.basic', 'tab.cut']).scroll).toEqual({ ratio: 0.5 });
    expect(filterClientScreenUi(ui('cut'), withShownFrameOnly(snapshot, 'basic'), ['tab.basic', 'tab.cut']).scroll).toEqual({ ratio: 0.5 });
  });

  it('is drawn only under its own tab', () => {
    const snapshot = buildClientScreenSnapshot(source({ frame: goodFrame() }), ['tab.basic', 'basic.order_name', 'tab.cut'], ids());
    const on = (tab: ClientScreenUi['tab']) => buildMirrorView(snapshot, { tab, focus: null, editing: null, scroll: null, page: null });
    expect(on('cut').frame).toEqual(goodFrame());
    expect(on('cut').fields).toEqual([]);
    expect(on('cut').table).toBeNull();
    expect(on('basic').frame).toBeNull();
    expect(on('cut').tabs.find((tab) => tab.active)?.label).toBe('Раскрой');
  });
});

describe('whole-tab copy: how long the manager side keeps it', () => {
  it('goes with the presentation and with a tick known to be off; a moment of not knowing keeps it', () => {
    expect(keepsClientScreenFrame(true, 'on')).toBe(true);
    // The customer window is being reopened, or the settings are not confirmed yet.
    expect(keepsClientScreenFrame(true, 'unknown')).toBe(true);
    expect(keepsClientScreenFrame(true, 'off')).toBe(false);
    for (const tick of ['on', 'off', 'unknown'] as const) expect(keepsClientScreenFrame(false, tick)).toBe(false);
    // A copy of an earlier presentation of the same order is never shown in a new one.
    for (const tick of ['on', 'unknown'] as const) expect(keepsClientScreenFrame(true, tick, false)).toBe(false);
  });
});

describe('whole-tab copy: the keeper lets it go by itself, with no order form on the page', () => {
  afterEach(() => vi.useRealTimers());
  const world = () => {
    const state = { presented: true, no: 1, tick: 'on' as FrameTick, changed: 0, listeners: new Set<() => void>() };
    const keeper = createClientScreenFrameKeeper({
      presented: () => state.presented,
      presentationNo: () => state.no,
      allowed: () => state.tick,
      changed: () => { state.changed += 1; },
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    });
    return { state, keeper, tell: () => state.listeners.forEach((listener) => listener()) };
  };

  it('keeps a copy, tells about a new one, and does not take the same one for a change', () => {
    const { state, keeper } = world();
    expect(keeper.get()).toBeNull();
    expect(state.listeners.size).toBe(0);
    keeper.put(goodFrame(), 'a');
    expect(keeper.get()).toEqual(goodFrame());
    expect(state.changed).toBe(1);
    keeper.put(goodFrame(), 'a');
    expect(state.changed).toBe(1);
    keeper.put(goodFrame({ height: 701 }), 'b');
    expect(state.changed).toBe(2);
    expect(keeper.get()?.height).toBe(701);
    keeper.drop();
  });

  it('the presentation ends: the copy is gone at once, the keeper stops listening', () => {
    const { state, keeper, tell } = world();
    keeper.put(goodFrame(), 'a');
    expect(state.listeners.size).toBe(1);
    state.presented = false;
    tell();
    expect(state.changed).toBe(2);
    expect(state.listeners.size).toBe(0);
    expect(keeper.get()).toBeNull();
  });

  it('the tick is taken off without any word from the presenter: gone on the next check, and not back when the tick returns', () => {
    vi.useFakeTimers();
    const { state, keeper } = world();
    keeper.put(goodFrame(), 'a');
    state.tick = 'off';
    vi.advanceTimersByTime(FRAME_KEEPER_CHECK_MS);
    expect(state.changed).toBe(2);
    state.tick = 'on';
    vi.advanceTimersByTime(FRAME_KEEPER_CHECK_MS * 3);
    expect(keeper.get()).toBeNull();
    expect(state.changed).toBe(2);
    expect(state.listeners.size).toBe(0);
  });

  it('a moment of not knowing the tick keeps the copy; asking for the copy is a check too', () => {
    const { state, keeper } = world();
    keeper.put(goodFrame(), 'a');
    state.tick = 'unknown';
    expect(keeper.get()).not.toBeNull();
    state.tick = 'off';
    expect(keeper.get()).toBeNull();
  });

  it('a copy is never carried into another presentation, nor taken while nothing is presented or the tick is off', () => {
    const { state, keeper } = world();
    keeper.put(goodFrame(), 'a');
    state.no = 2;
    expect(keeper.get()).toBeNull();
    // The same picture taken in the new presentation is a new copy.
    keeper.put(goodFrame(), 'a');
    expect(keeper.get()).not.toBeNull();
    keeper.drop();
    state.presented = false;
    keeper.put(goodFrame(), 'c');
    expect(keeper.get()).toBeNull();
    state.presented = true;
    state.tick = 'off';
    keeper.put(goodFrame(), 'd');
    expect(keeper.get()).toBeNull();
    expect(state.listeners.size).toBe(0);
  });
});

describe('whole-tab copy: the source with a page under it', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** The few members of a page the source touches: one tab with one picture in it. */
  function page() {
    const state = { presented: true, no: 1, tick: 'on' as FrameTick, changed: 0, redrawn: 0, listeners: new Set<() => void>() };
    const html = 'http://www.w3.org/1999/xhtml';
    const element = (tagName: string, attributes: Record<string, string>, extra: Record<string, unknown> = {}) => ({
      nodeType: 1, tagName, namespaceURI: html, className: attributes.class ?? '', isConnected: true, childNodes: [] as unknown[],
      attributes: Object.entries(attributes).map(([name, value]) => ({ name, value })),
      getAttribute: (name: string) => attributes[name] ?? null,
      addEventListener() {}, removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 100, width: 1200, height: 600 }),
      scrollHeight: 600, scrollTop: 0, scrollLeft: 0, parentElement: null as unknown,
      ...extra,
    });
    const root = element('HTML', {});
    const body = element('BODY', {}, { parentElement: root });
    const picture = element('IMG', { src: 'blob:https://app-test.mebelkz.app/1b2c', alt: 'Лист 1' }, {
      complete: true, naturalWidth: 40, naturalHeight: 20, currentSrc: 'blob:https://app-test.mebelkz.app/1b2c', src: 'blob:https://app-test.mebelkz.app/1b2c',
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20 }),
    });
    const tab = element('DIV', { 'data-client-screen-frame': 'cut' }, { parentElement: body, childNodes: [picture] });
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => { state.redrawn += 1; return PIXEL; } };
    const win = {
      document: { documentElement: root, body, styleSheets: [{ cssRules: [{ cssText: '.cut-page { color: red; }' }] }], createElement: () => canvas },
      devicePixelRatio: 1, innerWidth: 1500, innerHeight: 900, scrollX: 0, scrollY: 0,
      getComputedStyle: () => ({ overflowY: 'visible' }),
      setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
      addEventListener() {}, removeEventListener() {},
      performance: { now: () => 0, measure() {} },
    };
    const source = createClientScreenFrameSource({
      node: () => tab as never,
      presented: () => state.presented,
      presentationNo: () => state.no,
      allowed: () => state.tick,
      changed: () => { state.changed += 1; },
      scrolled() {},
      subscribe: (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    }, win as never);
    return { state, source, tell: () => state.listeners.forEach((listener) => listener()) };
  }
  const withPage = () => {
    vi.useFakeTimers();
    vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
    return page();
  };

  it('takes a copy of the tab with its picture inside, and redraws a picture it has seen only once', () => {
    const { state, source } = withPage();
    source.sync('cut');
    expect(source.get()).toBeNull();
    vi.advanceTimersByTime(FRAME_CAPTURE_MS + 50);
    const frame = source.get();
    expect(frame).toMatchObject({ tab: 'cut', viewport: { w: 1500, h: 900 }, left: 0, top: 100, width: 1200, height: 600, styles: ['.cut-page { color: red; }\n'] });
    expect(frame?.tree).toEqual({ t: 'div', a: { 'data-client-screen-frame': 'cut' }, c: [{ t: 'img', a: { alt: 'Лист 1', src: PIXEL } }] });
    expect(JSON.stringify(frame)).not.toContain('blob:');
    expect(state.redrawn).toBe(1);
    expect(source.heldPictures()).toBe(1);
    expect(state.changed).toBe(1);
  });

  it('the form is gone and the presentation ends: the copy and the pictures redrawn for it are thrown away, with no form to do it', () => {
    const { state, source, tell } = withPage();
    source.sync('cut');
    vi.advanceTimersByTime(FRAME_CAPTURE_MS + 50);
    expect(source.heldPictures()).toBe(1);
    // The order form leaves the page; from here on nobody calls the source.
    source.stop();
    expect(source.get()).not.toBeNull();
    state.presented = false;
    tell();
    expect(source.heldPictures()).toBe(0);
    expect(source.get()).toBeNull();
    expect(state.listeners.size).toBe(0);
  });

  it('the form is gone and the tick is taken off: the same, on the keeper\'s own timer', () => {
    const { state, source } = withPage();
    source.sync('cut');
    vi.advanceTimersByTime(FRAME_CAPTURE_MS + 50);
    source.stop();
    state.tick = 'off';
    vi.advanceTimersByTime(FRAME_KEEPER_CHECK_MS);
    expect(source.heldPictures()).toBe(0);
    expect(source.get()).toBeNull();
  });

  it('a copy taken a moment after the presentation ended is not kept, and neither are its pictures', () => {
    const { state, source } = withPage();
    source.sync('cut');
    // The capture is already on its way when the presentation ends.
    state.presented = false;
    vi.advanceTimersByTime(FRAME_CAPTURE_MS + 50);
    expect(source.get()).toBeNull();
    expect(source.heldPictures()).toBe(0);
    expect(state.changed).toBe(0);
  });

  it('nothing of the page is read without the tick', () => {
    const { state, source } = withPage();
    state.tick = 'off';
    source.sync('cut');
    vi.advanceTimersByTime(FRAME_CAPTURE_MS * 3);
    expect(state.redrawn).toBe(0);
    expect(source.get()).toBeNull();
    state.tick = 'unknown';
    source.sync('cut');
    vi.advanceTimersByTime(FRAME_CAPTURE_MS * 3);
    expect(state.redrawn).toBe(0);
  });
});

describe('whole-tab copy: the box it is drawn in', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

  it('can never run a script and can ask the network only for a font file of this build', () => {
    const component = read('./ClientScreenFrame.tsx');
    expect(component).toContain("export const CLIENT_SCREEN_FRAME_SANDBOX = 'allow-same-origin';");
    expect(component).toContain('sandbox={CLIENT_SCREEN_FRAME_SANDBOX}');
    expect(component).not.toMatch(/allow-scripts|allow-forms|allow-popups|allow-top-navigation|allow-modals/);
    expect(component).toContain("return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data: ${origin}/assets/`;");
    // The policy is the first thing in the page of the box.
    expect(component).toContain('`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${clientScreenFramePolicy(origin)}">');
  });

  it('the holder of the box stays on the page for a tab too large to show, so the width is measured when the tab fits again', () => {
    const component = read('./ClientScreenFrame.tsx');
    expect(component).toContain('<div ref={outerRef} className="client-screen__frame client-screen__frame--note">');
    expect(component.match(/ref=\{outerRef\}/g)).toHaveLength(2);
    expect(component).not.toMatch(/return <div className="client-screen__empty">/);
  });

  it('no markup is parsed anywhere in the customer screen: elements are created one by one', () => {
    const folder = new URL('./', import.meta.url);
    for (const file of readdirSync(folder).filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))) {
      expect(read(`./${file}`), file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|document\.write|createContextualFragment|dangerouslySetInnerHTML/);
    }
  });
});
