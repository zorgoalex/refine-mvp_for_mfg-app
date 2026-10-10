import type { ClientScreenFrame, ClientScreenFrameTabKey } from './clientScreenSnapshotSchema';

/**
 * Holds the last whole-tab copy taken for one presentation of an order, on the manager's side. The
 * copy outlives the order form (the form may leave the page while its order is presented), so the
 * keeper looks after it by itself: while it holds a copy it listens to the presenter and checks on
 * a timer, and lets the copy go as soon as the presentation is over, another one has begun, or the
 * tick of the tab is known to be off. No form has to be on the page for that. No DOM in here.
 */
export type FrameTick = 'on' | 'off' | 'unknown';

/**
 * Does the copy taken earlier stay? It belongs to one presentation and goes with it and with the
 * tick of its tab — and only when the tick is known to be off: a moment when that cannot be told
 * (the customer window is being reopened, the settings are not confirmed) is not a reason.
 */
export function keepsClientScreenFrame(presented: boolean, tick: FrameTick, samePresentation = true): boolean {
  return presented && samePresentation && tick !== 'off';
}

export const FRAME_KEEPER_CHECK_MS = 1000;

export interface FrameKeeperDeps {
  /** Is the order of this draft the one presented right now? */
  presented(): boolean;
  /** The number of the presentation going on: a copy is never carried from one presentation into another. */
  presentationNo(): number;
  /** The tick of a tab in the settings in force. */
  allowed(tab: ClientScreenFrameTabKey): FrameTick;
  /** The copy held has changed (a new one, or none any more). */
  changed(): void;
  /** Changes of the presentation; returns the way to stop listening. */
  subscribe(listener: () => void): () => void;
  /**
   * The copy has been let go: whatever was prepared for it (pictures redrawn for the copy, the
   * styles of the page) is to be thrown away as well — nothing of a presentation outlives it.
   */
  released?(): void;
}

export interface ClientScreenFrameKeeper {
  /** The copy, if it still may be kept; asking is also a check. */
  get(): ClientScreenFrame | null;
  /** A new copy; `key` tells copies apart, the same key is not a change. */
  put(frame: ClientScreenFrame, key: string): void;
  check(): void;
  drop(): void;
}

export function createClientScreenFrameKeeper(deps: FrameKeeperDeps): ClientScreenFrameKeeper {
  let frame: ClientScreenFrame | null = null;
  let key = '';
  let presentation = -1;
  let stopGuard: (() => void) | null = null;

  const drop = () => {
    stopGuard?.();
    stopGuard = null;
    const had = frame !== null;
    frame = null;
    key = '';
    try {
      deps.released?.();
    } finally {
      if (had) deps.changed();
    }
  };
  const check = () => {
    if (frame !== null && !keepsClientScreenFrame(deps.presented(), deps.allowed(frame.tab), presentation === deps.presentationNo())) drop();
  };
  const guard = () => {
    if (stopGuard) return;
    const safely = () => {
      try {
        check();
      } catch {
        // a check that cannot be made keeps nothing: better no copy than one nobody looks after
        drop();
      }
    };
    const unsubscribe = deps.subscribe(safely);
    const timer = setInterval(safely, FRAME_KEEPER_CHECK_MS);
    stopGuard = () => {
      unsubscribe();
      clearInterval(timer);
    };
  };

  return {
    get() {
      check();
      return frame;
    },
    put(next, nextKey) {
      if (!keepsClientScreenFrame(deps.presented(), deps.allowed(next.tab))) {
        // Taken a moment too late (the presentation has just ended): nothing is kept, nothing prepared stays.
        drop();
        return;
      }
      if (frame !== null && nextKey === key && presentation === deps.presentationNo()) return;
      frame = next;
      key = nextKey;
      presentation = deps.presentationNo();
      guard();
      deps.changed();
    },
    check,
    drop,
  };
}
