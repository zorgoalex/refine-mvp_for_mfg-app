import {
  captureClientScreenFrame, captureFrameStyles, captureFrameSurroundings,
  type FrameImageEncoder, type FrameSourceElement,
} from './clientScreenFrameCapture';
import { clientScreenFrameSchema, type ClientScreenFrame, type ClientScreenFrameTabKey } from './clientScreenSnapshotSchema';

/**
 * Manager window only. Keeps the whole-tab copy of one presented order up to date while the manager
 * is on such a tab, and keeps the last copy afterwards — on a tab the customer does not see, on
 * another screen of the app — until the presentation ends or the tick of the tab is taken off.
 * Nothing of the tab is read without that tick.
 */
export const clientScreenFrameNodeKey = (tab: ClientScreenFrameTabKey): string => `frame-node:${tab}`;

export const FRAME_CAPTURE_MS = 400;
export const CLIENT_SCREEN_FRAME_MEASURE = 'client-screen-frame-copy';
const IMAGE_SIDE_LIMIT = 2000;
const IMAGE_CACHE_LIMIT = 200;

/**
 * Redraws a picture the page already shows into an inline image, at the size it has on screen.
 * `null` while it is not loaded or when the browser refuses to read it. Redrawing a large picture
 * takes time, so one copy of the tab redraws at most one picture it has not seen yet; the rest are
 * empty boxes in that copy and come with the next ones (`begin` starts a copy, `pending` tells
 * whether pictures are still owed).
 */
export function createFrameImageEncoder(doc: Document, ratio: number): { encode: FrameImageEncoder; begin(): void; pending(): boolean; clear(): void } {
  const cache = new Map<string, string>();
  let fresh = 0;
  let owed = false;
  const encode: FrameImageEncoder = (source) => {
    const element = source as unknown as HTMLImageElement | HTMLCanvasElement;
    const isCanvas = element.tagName.toLowerCase() === 'canvas';
    const image = element as HTMLImageElement;
    if (!isCanvas && (!image.complete || !image.naturalWidth)) return null;
    const box = element.getBoundingClientRect();
    const scale = Math.max(1, Math.min(3, ratio || 1)) * 1.5;
    let width = Math.round((box.width || (isCanvas ? element.width : image.naturalWidth)) * scale);
    let height = Math.round((box.height || (isCanvas ? element.height : image.naturalHeight)) * scale);
    if (width < 1 || height < 1) return null;
    const shrink = Math.min(1, IMAGE_SIDE_LIMIT / Math.max(width, height));
    width = Math.max(1, Math.round(width * shrink));
    height = Math.max(1, Math.round(height * shrink));
    const key = isCanvas ? null : `${image.currentSrc || image.src}|${width}x${height}`;
    const known = key === null ? undefined : cache.get(key);
    if (known !== undefined) return known;
    // (A canvas is drawn anew every time and is never put off: there is nothing to wait for.)
    if (key !== null) {
      if (fresh >= 1) {
        owed = true;
        return null;
      }
      fresh += 1;
    }
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(element, 0, 0, width, height);
    let data = canvas.toDataURL('image/webp', 0.9);
    if (!data.startsWith('data:image/webp;base64,')) data = canvas.toDataURL('image/png');
    if (key !== null) {
      if (cache.size >= IMAGE_CACHE_LIMIT) cache.clear();
      cache.set(key, data);
    }
    return data;
  };
  return {
    encode,
    begin() {
      fresh = 0;
      owed = false;
    },
    pending: () => owed,
    clear: () => cache.clear(),
  };
}

export interface FrameSourceDeps {
  /** The area of the tab on the page, or null while the tab is not there. */
  node(tab: ClientScreenFrameTabKey): HTMLElement | null;
  /**
   * The tick of this tab in the settings in force. `unknown` — it cannot be told right now (the
   * customer window is being reopened, the settings are not confirmed): nothing is read from the
   * page then, and the copy already taken is kept until the answer is known.
   */
  allowed(tab: ClientScreenFrameTabKey): 'on' | 'off' | 'unknown';
  changed(): void;
  /** Only the scroll offset of the area the tab lives in changed. */
  scrolled(): void;
}

/**
 * Does the copy taken earlier stay? It goes with the presentation and with the tick of its tab,
 * and only when the tick is known to be off: a moment when that cannot be told is not a reason.
 */
export function keepsClientScreenFrame(presented: boolean, tick: 'on' | 'off' | 'unknown'): boolean {
  return presented && tick !== 'off';
}

export interface ClientScreenFrameSource {
  get(): ClientScreenFrame | null;
  /** How far the area the copied tab lives in is scrolled right now; the last known value when the tab is away. */
  scrollTop(): number;
  /** Called on every change of what decides the capture: the manager's tab, the presentation, the settings. */
  sync(tab: ClientScreenFrameTabKey | null, presented: boolean): void;
  stop(): void;
}

export function createClientScreenFrameSource(deps: FrameSourceDeps, win: Window = window): ClientScreenFrameSource {
  const doc = win.document;
  const images = createFrameImageEncoder(doc, win.devicePixelRatio);
  let frame: ClientScreenFrame | null = null;
  let frameKey = '';
  let watched: { tab: ClientScreenFrameTabKey; node: HTMLElement; scroller: HTMLElement | null; stop(): void } | null = null;
  let lastScrollTop = 0;

  /** The nearest ancestor that scrolls the tab; null — the window does. */
  const scrollerOf = (node: HTMLElement): HTMLElement | null => {
    for (let current = node.parentElement; current && current !== doc.body && current !== doc.documentElement; current = current.parentElement) {
      const overflow = win.getComputedStyle(current).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight + 1) return current;
    }
    return null;
  };
  const readScrollTop = (): number => {
    if (watched?.node.isConnected) lastScrollTop = Math.max(0, Math.round(watched.scroller ? watched.scroller.scrollTop : win.scrollY));
    return lastScrollTop;
  };
  let timer = 0;
  let lastAt = 0;
  /** A copy that took long is taken less often, so the manager's own work is never held up by it. */
  let pause = FRAME_CAPTURE_MS;
  let styles: { signature: string; blocks: string[] | null } | null = null;

  const set = (next: ClientScreenFrame | null, key: string) => {
    if (key === frameKey) return;
    frame = next;
    frameKey = key;
    deps.changed();
  };

  const pageStyles = (): string[] | null => {
    const sheets = Array.from(doc.styleSheets);
    let rules = 0;
    try {
      for (const sheet of sheets) rules += sheet.cssRules.length;
    } catch {
      return null;
    }
    const signature = `${sheets.length}:${rules}`;
    if (styles?.signature !== signature) styles = { signature, blocks: captureFrameStyles(sheets) };
    return styles.blocks;
  };

  const capture = () => {
    timer = 0;
    if (!watched || !watched.node.isConnected || deps.allowed(watched.tab) !== 'on') return;
    const box = watched.node.getBoundingClientRect();
    // A hidden tab (another screen of the app is on top) has no size: the last copy stays.
    if (box.width < 200 || box.height < 1) return;
    lastAt = Date.now();
    const startedAt = win.performance?.now?.() ?? 0;
    // The area that scrolls the tab may appear or go as the content grows: looked up on every copy.
    const scroller = scrollerOf(watched.node);
    if (scroller !== watched.scroller) {
      watch(watched.tab, watched.node);
      return;
    }
    const area = scroller?.getBoundingClientRect() ?? null;
    const blocks = pageStyles();
    images.begin();
    const tree = blocks ? captureClientScreenFrame(watched.node as unknown as FrameSourceElement, images.encode).tree : null;
    const surroundings = captureFrameSurroundings(watched.node, doc.documentElement, doc.body);
    const candidate = {
      tab: watched.tab,
      viewport: { w: Math.round(win.innerWidth), h: Math.round(win.innerHeight) },
      port: scroller ? { w: Math.max(1, scroller.clientWidth), h: Math.max(1, scroller.clientHeight) } : { w: Math.round(win.innerWidth), h: Math.round(win.innerHeight) },
      left: Math.max(0, Math.round(area && scroller ? box.left - area.left - scroller.clientLeft + scroller.scrollLeft : box.left + win.scrollX)),
      top: Math.max(0, Math.round(area && scroller ? box.top - area.top - scroller.clientTop + scroller.scrollTop : box.top + win.scrollY)),
      width: Math.round(box.width),
      height: Math.max(1, Math.round(Math.max(box.height, watched.node.scrollHeight))),
      tree,
      shells: surroundings.shells,
      root: surroundings.root,
      styles: blocks ?? [],
    };
    // What cannot go over the wire is not kept either: the customer keeps the previous copy.
    const parsed = clientScreenFrameSchema.safeParse(candidate);
    if (!parsed.success) return;
    const { styles: _styles, ...rest } = parsed.data;
    set(parsed.data, `${styles?.signature ?? ''}|${JSON.stringify(rest)}`);
    const spent = (win.performance?.now?.() ?? 0) - startedAt;
    // Pictures still owed come with the next copy, at the usual pace.
    pause = images.pending() ? FRAME_CAPTURE_MS : Math.min(4000, Math.max(FRAME_CAPTURE_MS, Math.round(spent * 8)));
    if (images.pending()) schedule();
    // How long one copy takes is visible in the browser's own timings (User Timing).
    try {
      win.performance?.measure?.(CLIENT_SCREEN_FRAME_MEASURE, { start: startedAt, end: win.performance.now() });
    } catch {
      // timings are a convenience only
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = win.setTimeout(capture, Math.max(0, pause - (Date.now() - lastAt)));
  };

  const unwatch = () => {
    watched?.stop();
    watched = null;
    if (timer) win.clearTimeout(timer);
    timer = 0;
  };

  const watch = (tab: ClientScreenFrameTabKey, node: HTMLElement) => {
    unwatch();
    const mutations = new MutationObserver(schedule);
    mutations.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    sizes?.observe(node);
    const events = ['scroll', 'input', 'change', 'load'] as const;
    for (const event of events) node.addEventListener(event, schedule, { capture: true, passive: true });
    win.addEventListener('resize', schedule);
    const scroller = scrollerOf(node);
    const scrollTarget: HTMLElement | Window = scroller ?? win;
    let reported = -1;
    const onScroll = () => {
      const next = readScrollTop();
      if (next === reported) return;
      reported = next;
      deps.scrolled();
    };
    scrollTarget.addEventListener('scroll', onScroll, { passive: true });
    watched = {
      tab, node, scroller,
      stop() {
        mutations.disconnect();
        sizes?.disconnect();
        for (const event of events) node.removeEventListener(event, schedule, { capture: true });
        win.removeEventListener('resize', schedule);
        scrollTarget.removeEventListener('scroll', onScroll);
      },
    };
    schedule();
  };

  return {
    get: () => frame,
    scrollTop: readScrollTop,
    sync(tab, presented) {
      if (!presented) {
        lastScrollTop = 0;
        unwatch();
        images.clear();
        styles = null;
        set(null, '');
        return;
      }
      // The tick was taken off: the copy is gone at once, whatever tab the manager is on.
      if (frame && !keepsClientScreenFrame(presented, deps.allowed(frame.tab))) set(null, '');
      const node = tab && deps.allowed(tab) === 'on' ? deps.node(tab) : null;
      if (!tab || !node) {
        // Not on a whole tab, or it is not on the page: nothing is read; the last copy stays.
        unwatch();
        return;
      }
      if (watched?.tab !== tab || watched.node !== node) watch(tab, node);
    },
    stop: unwatch,
  };
}
