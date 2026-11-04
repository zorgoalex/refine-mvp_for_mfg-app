import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runIsolatedPrint } from './isolatedPrint';

type Node = { className?: string; textContent?: string; style: { cssText: string }; children: Node[]; parent: Node | null;
  append: (...nodes: Node[]) => void; remove: () => void };
const node = (): Node => {
  const self: Node = {
    style: { cssText: '' }, children: [], parent: null,
    append: (...nodes) => nodes.forEach((child) => { child.parent = self; self.children.push(child); }),
    remove: () => { if (self.parent) self.parent.children = self.parent.children.filter((c) => c !== self); self.parent = null; },
  };
  return self;
};

let frames: Array<() => void>;
let rootClasses: Set<string>;
let body: Node;
let head: Node;
let listeners: Map<string, () => void>;

beforeEach(() => {
  frames = [];
  rootClasses = new Set();
  body = node();
  head = node();
  listeners = new Map();
  vi.stubGlobal('document', {
    documentElement: { classList: { add: (c: string) => rootClasses.add(c), remove: (c: string) => rootClasses.delete(c) } },
    createElement: () => node(),
    body,
    head,
  });
  vi.stubGlobal('window', {
    addEventListener: (event: string, fn: () => void) => listeners.set(event, fn),
    removeEventListener: (event: string) => listeners.delete(event),
    print: () => undefined,
  });
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { frames.push(fn); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

const run = (print: () => void, onDone = vi.fn()) => ({
  onDone,
  cancel: runIsolatedPrint({
    containerClass: 'paper', rootClass: 'printing', pageRule: '@page {}', sheets: [node() as unknown as HTMLElement],
    onDone, print,
  }),
});
const flush = () => { while (frames.length) frames.shift()!(); };

describe('isolated print', () => {
  it('prints the sheet in its container, then restores the page', () => {
    const print = vi.fn(() => {
      expect(rootClasses.has('printing')).toBe(true);
      expect(body.children).toHaveLength(1);
      expect(head.children).toHaveLength(1);
    });
    const { onDone } = run(print);
    flush();
    expect(print).toHaveBeenCalledTimes(1);
    expect(rootClasses.size).toBe(0);
    expect(body.children).toHaveLength(0);
    expect(head.children).toHaveLength(0);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it('cancelled between frames: no print, the page is restored once', () => {
    const print = vi.fn();
    const { onDone, cancel } = run(print);
    frames.shift()!(); // first frame only
    cancel();
    flush();
    expect(print).not.toHaveBeenCalled();
    expect(rootClasses.size + body.children.length + head.children.length).toBe(0);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('print() throwing still restores the page', () => {
    const { onDone } = run(() => { throw new Error('no printer'); });
    expect(() => flush()).toThrow('no printer');
    expect(rootClasses.size + body.children.length + head.children.length).toBe(0);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('print snapshot', () => {
  it('only the snapshot of the current settings is printed (a column or paper change makes it stale)', async () => {
    const { currentPrintSnapshot } = await import('./isolatedPrint');
    const snapshot = { key: 'A3#a|b', paper: 'A3' as const, sheets: [{} as HTMLElement] };
    expect(currentPrintSnapshot(snapshot, 'A3#a|b')).toBe(snapshot);
    expect(currentPrintSnapshot(snapshot, 'A3#a')).toBeNull();
    expect(currentPrintSnapshot(snapshot, 'A4#a|b')).toBeNull();
    expect(currentPrintSnapshot({ ...snapshot, sheets: [] }, 'A3#a|b')).toBeNull();
    expect(currentPrintSnapshot(null, 'A3#a|b')).toBeNull();
  });
});
