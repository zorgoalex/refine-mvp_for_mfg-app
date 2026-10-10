/**
 * Where a whole-tab copy stands in its box and which part of the box the customer sees. Pure.
 *
 * The box is the manager's window; the tab stands in it where it stands in the manager's scrolled
 * area, and the box is scrolled by the manager's own offset — so everything pinned inside the tab is
 * pinned at the same place. The customer sees only the part of the tab that is in sight, scaled to
 * the width at hand.
 */
export interface FrameGeometry {
  viewport: { w: number; h: number };
  /** The visible part of the scrolled area the tab lives in. */
  port: { w: number; h: number };
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FrameWindow {
  scale: number;
  /** Scroll offset of the box. */
  scrollTop: number;
  /** Shift of the box inside the clipping area, already scaled. */
  shiftX: number;
  shiftY: number;
  /** Size of the clipping area. */
  shownWidth: number;
  shownHeight: number;
  /** Height the document of the box must have for that scroll offset to be reachable. */
  pageHeight: number;
}

export function clientScreenFrameWindow(frame: FrameGeometry, frameTop: number, available: number): FrameWindow {
  const scale = available > 0 && frame.width > 0 ? available / frame.width : 1;
  const scrollTop = Math.max(0, Math.min(frameTop, frame.top + frame.height));
  const from = Math.max(0, frame.top - scrollTop);
  const to = Math.min(frame.port.h, frame.top + frame.height - scrollTop);
  return {
    scale,
    scrollTop,
    shiftX: -frame.left * scale,
    shiftY: -from * scale,
    shownWidth: frame.width * scale,
    shownHeight: Math.max(0, to - from) * scale,
    pageHeight: frame.top + frame.height + frame.viewport.h,
  };
}
