import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clientScreenFrameWindow } from './clientScreenFrameLayout';
import type { ClientScreenFrameNode } from './clientScreenFrameTree';
import type { ClientScreenFrame as Frame } from './clientScreenSnapshotSchema';

/**
 * Draws a whole tab of the manager's screen from its inert copy. The copy lives in a box of its own
 * that can never run a script (its sandbox does not let any run) and can never ask the network for
 * anything but a font file of this build (its own content policy). Elements are created one by one
 * from the checked tree; no markup is parsed.
 *
 * The box is exactly as large as the manager's window and is scrolled as the manager's own area is,
 * so the tab is laid out and pinned as on the manager's screen; the customer sees only the part of
 * the tab that is in sight, scaled to the width at hand.
 */
export const CLIENT_SCREEN_FRAME_SANDBOX = 'allow-same-origin';

export function clientScreenFramePolicy(origin: string): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data: ${origin}/assets/`;
}

/** The constant empty page of the box; the policy is the first thing in it. */
export function clientScreenFrameDocument(origin: string): string {
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${clientScreenFramePolicy(origin)}"><meta charset="utf-8"></head><body></body></html>`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SCROLL_ATTRIBUTE = 'data-cs-scroll';
/** Ancestors only make selectors match and pass inherited values down; the box of the tab is laid out by itself. */
const OWN_STYLE = 'html,body{margin:0!important;padding:0!important;overflow:hidden!important;min-width:0!important}'
  + '[data-cs-shell]{display:contents!important}'
  + '[data-cs-tab]{display:block!important;box-sizing:border-box!important;margin:0!important;position:absolute!important}'
  // The copy is redrawn as a whole, so nothing in it may start moving again — but an animation is
  // taken to its end, not removed: what it leaves on screen (an element faded in) stays as the manager sees it.
  + '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;'
  + 'transition:none!important;caret-color:transparent!important}';

function build(doc: Document, node: ClientScreenFrameNode): Node {
  if (typeof node === 'string') return doc.createTextNode(node);
  const element = node.s === 1 ? doc.createElementNS(SVG_NS, node.t) : doc.createElement(node.t);
  for (const [name, value] of Object.entries(node.a ?? {})) {
    try {
      element.setAttribute(name, value);
    } catch {
      // a name the browser refuses is left out
    }
  }
  for (const child of node.c ?? []) element.appendChild(build(doc, child));
  return element;
}

function setRoot(element: HTMLElement, cls: string, data: Record<string, string>, style: string): void {
  for (const name of Array.from(element.attributes).map((attribute) => attribute.name)) element.removeAttribute(name);
  if (cls) element.setAttribute('class', cls);
  for (const [name, value] of Object.entries(data)) element.setAttribute(name, value);
  if (style) element.setAttribute('style', style);
}

function fill(doc: Document, frame: Frame, drawnStyles: { current: readonly string[] | null }): void {
  setRoot(doc.documentElement, frame.root.htmlCls, frame.root.htmlData, frame.root.htmlStyle);
  setRoot(doc.body, frame.root.bodyCls, frame.root.bodyData, frame.root.bodyStyle);
  if (drawnStyles.current !== frame.styles) {
    for (const old of Array.from(doc.head.querySelectorAll('style'))) old.remove();
    for (const text of [...frame.styles, OWN_STYLE]) {
      const style = doc.createElement('style');
      style.textContent = text;
      doc.head.appendChild(style);
    }
    drawnStyles.current = frame.styles;
  }
  const tab = doc.createElement('div');
  tab.setAttribute('data-cs-tab', '');
  tab.setAttribute('style', `left:${frame.left}px;top:${frame.top}px;width:${frame.width}px`);
  if (frame.tree) tab.appendChild(build(doc, frame.tree));
  let top: HTMLElement = tab;
  for (const shell of [...frame.shells].reverse()) {
    const element = doc.createElement(shell.tag);
    if (shell.cls) element.setAttribute('class', shell.cls);
    for (const [name, value] of Object.entries(shell.data)) element.setAttribute(name, value);
    if (shell.style) element.setAttribute('style', shell.style);
    element.setAttribute('data-cs-shell', '');
    element.appendChild(top);
    top = element;
  }
  // Room below the tab, so that the box can be scrolled as far as the manager's area is.
  const room = doc.createElement('div');
  room.setAttribute('style', `position:absolute;left:0;top:0;width:1px;height:${frame.top + frame.height + frame.viewport.h}px;visibility:hidden`);
  doc.body.replaceChildren(top, room);
  for (const element of Array.from(doc.body.querySelectorAll(`[${SCROLL_ATTRIBUTE}]`))) {
    const [scrollTop, scrollLeft] = (element.getAttribute(SCROLL_ATTRIBUTE) ?? '').split(',').map(Number);
    if (Number.isFinite(scrollTop)) element.scrollTop = scrollTop;
    if (Number.isFinite(scrollLeft)) element.scrollLeft = scrollLeft;
  }
}

export const ClientScreenFrame: React.FC<{ frame: Frame; frameTop: number }> = ({ frame, frameTop }) => {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const boxRef = useRef<HTMLIFrameElement | null>(null);
  const drawnStyles = useRef<readonly string[] | null>(null);
  const [ready, setReady] = useState(0);
  const [available, setAvailable] = useState(0);
  const page = useMemo(() => clientScreenFrameDocument(typeof window === 'undefined' ? '' : window.location.origin), []);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    if (!outer) return undefined;
    const measure = () => setAvailable(outer.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    let pending = 0;
    const observer = new ResizeObserver(() => {
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        measure();
      });
    });
    observer.observe(outer);
    return () => {
      observer.disconnect();
      if (pending) cancelAnimationFrame(pending);
    };
  }, []);

  useEffect(() => {
    const doc = boxRef.current?.contentDocument;
    if (!ready || !doc?.body || frame.tree === null) return;
    fill(doc, frame, drawnStyles);
  }, [frame, ready]);

  const shown = clientScreenFrameWindow(frame, frameTop, available);

  // The box is scrolled exactly as far as the manager's own area.
  useEffect(() => {
    if (!ready) return;
    boxRef.current?.contentWindow?.scrollTo(0, shown.scrollTop);
  }, [frame, ready, shown.scrollTop]);

  if (frame.tree === null) return <div className="client-screen__empty">Вкладка слишком большая для показа</div>;

  return (
    <div ref={outerRef} className="client-screen__frame" style={{ height: Math.ceil(shown.shownHeight) }}>
      <iframe
        ref={boxRef}
        title="Вкладка заказа"
        className="client-screen__frame-box"
        sandbox={CLIENT_SCREEN_FRAME_SANDBOX}
        srcDoc={page}
        tabIndex={-1}
        onLoad={() => {
          drawnStyles.current = null;
          setReady((value) => value + 1);
        }}
        style={{ width: frame.viewport.w, height: frame.viewport.h, transform: `translate(${shown.shiftX}px, ${shown.shiftY}px) scale(${shown.scale})` }}
      />
    </div>
  );
};
