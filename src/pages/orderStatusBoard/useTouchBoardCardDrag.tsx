import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  TOUCH_BOARD_LONG_PRESS_MS,
  claimTouchBoardDrop,
  exceedsTouchBoardSlop,
  shouldActivateTouchBoardDrag,
  touchBoardEdgeScrollDelta,
  type TouchBoardPoint,
} from './touchBoardDrag';

export interface TouchBoardDragDestination {
  key: string;
  statusId: number;
  statusName: string;
}

interface TouchBoardCardDragOptions {
  enabled: boolean;
  orderNumber: string;
  sourceColumn: string;
  statusName: string;
  destinations: TouchBoardDragDestination[];
  onAnnounce: (message: string) => void;
  onDrop: (destination: TouchBoardDragDestination, trigger: HTMLElement) => void;
}

interface TouchBoardGesture {
  activated: boolean;
  completed: boolean;
  destinations: Map<string, TouchBoardDragDestination>;
  frame: number | null;
  handle: HTMLElement;
  keydown: (event: KeyboardEvent) => void;
  orientationChange: () => void;
  overKey: string | null;
  point: TouchBoardPoint;
  pointerId: number;
  sourceColumn: string;
  start: TouchBoardPoint;
  startedAt: number;
  timer: number | null;
  validKeys: Set<string>;
  viewport: HTMLElement | null;
}

interface TouchBoardDragVisual {
  orderNumber: string;
  statusName: string;
  x: number;
  y: number;
}

export interface TouchBoardDragHandleProps {
  onClickCapture: React.MouseEventHandler<HTMLElement>;
  onLostPointerCapture: React.PointerEventHandler<HTMLElement>;
  onPointerCancel: React.PointerEventHandler<HTMLElement>;
  onPointerDown: React.PointerEventHandler<HTMLElement>;
  onPointerMove: React.PointerEventHandler<HTMLElement>;
  onPointerUp: React.PointerEventHandler<HTMLElement>;
}

const TOUCH_CLICK_SUPPRESSION_MS = 420;

function columnKeyAtPoint(point: TouchBoardPoint): string | null {
  const element = document.elementFromPoint(point.x, point.y);
  const column = element?.closest<HTMLElement>('[data-status-board-column-key]');
  return column?.dataset.statusBoardColumnKey ?? null;
}

function columnByKey(viewport: HTMLElement, key: string): HTMLElement | null {
  return Array.from(
    viewport.querySelectorAll<HTMLElement>('[data-status-board-column-key]'),
  ).find((column) => column.dataset.statusBoardColumnKey === key) ?? null;
}

function clearTouchBoardMarks(viewport: HTMLElement | null): void {
  if (!viewport) return;
  viewport.classList.remove('status-board-viewport--touch-dragging');
  for (const column of viewport.querySelectorAll<HTMLElement>('[data-status-board-column-key]')) {
    column.removeAttribute('data-touch-drop-valid');
    column.removeAttribute('data-touch-drop-over');
  }
}

function markTouchBoardDestinations(
  viewport: HTMLElement | null,
  validKeys: ReadonlySet<string>,
): void {
  if (!viewport) return;
  viewport.classList.add('status-board-viewport--touch-dragging');
  for (const column of viewport.querySelectorAll<HTMLElement>('[data-status-board-column-key]')) {
    column.dataset.touchDropValid = validKeys.has(column.dataset.statusBoardColumnKey ?? '')
      ? 'true'
      : 'false';
  }
}

export function useTouchBoardCardDrag(options: TouchBoardCardDragOptions): {
  active: boolean;
  ghost: React.ReactPortal | null;
  handleProps: TouchBoardDragHandleProps;
} {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gestureRef = useRef<TouchBoardGesture | null>(null);
  const suppressClickUntilRef = useRef(0);
  const [visual, setVisual] = useState<TouchBoardDragVisual | null>(null);

  const cleanup = useCallback(() => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    if (gesture.timer !== null) window.clearTimeout(gesture.timer);
    if (gesture.frame !== null) window.cancelAnimationFrame(gesture.frame);
    document.removeEventListener('keydown', gesture.keydown);
    window.removeEventListener('orientationchange', gesture.orientationChange);
    window.removeEventListener('resize', gesture.orientationChange);
    clearTouchBoardMarks(gesture.viewport);
    try {
      if (gesture.handle.hasPointerCapture(gesture.pointerId)) {
        gesture.handle.releasePointerCapture(gesture.pointerId);
      }
    } catch {
      // Pointer capture may already be released by the browser.
    }
    setVisual(null);
  }, []);

  const cancelActive = useCallback((announce: boolean) => {
    const gesture = gestureRef.current;
    const wasActive = Boolean(gesture?.activated);
    cleanup();
    if (announce && wasActive) {
      optionsRef.current.onAnnounce(`Перемещение заказа ${optionsRef.current.orderNumber} отменено.`);
    }
  }, [cleanup]);

  const updateOverColumn = useCallback((gesture: TouchBoardGesture) => {
    const candidate = columnKeyAtPoint(gesture.point);
    const nextKey = gesture.validKeys.has(candidate ?? '') ? candidate : null;
    if (nextKey === gesture.overKey) return;
    if (gesture.viewport && gesture.overKey) {
      columnByKey(gesture.viewport, gesture.overKey)?.removeAttribute('data-touch-drop-over');
    }
    gesture.overKey = nextKey;
    if (gesture.viewport && nextKey) {
      columnByKey(gesture.viewport, nextKey)?.setAttribute('data-touch-drop-over', 'true');
    }
  }, []);

  const startAutoScroll = useCallback((gesture: TouchBoardGesture) => {
    const tick = () => {
      if (gestureRef.current !== gesture || !gesture.activated) return;
      const viewport = gesture.viewport;
      if (viewport) {
        const viewportRect = viewport.getBoundingClientRect();
        viewport.scrollLeft += touchBoardEdgeScrollDelta(
          gesture.point.x,
          viewportRect.left,
          viewportRect.right,
        );
        if (gesture.overKey) {
          const cards = columnByKey(viewport, gesture.overKey)
            ?.querySelector<HTMLElement>('.status-board-column__cards');
          if (cards) {
            const cardsRect = cards.getBoundingClientRect();
            cards.scrollTop += touchBoardEdgeScrollDelta(
              gesture.point.y,
              cardsRect.top,
              cardsRect.bottom,
            );
          }
        }
        updateOverColumn(gesture);
      }
      gesture.frame = window.requestAnimationFrame(tick);
    };
    gesture.frame = window.requestAnimationFrame(tick);
  }, [updateOverColumn]);

  const onPointerDown = useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    if (
      !optionsRef.current.enabled ||
      event.pointerType !== 'touch' ||
      !event.isPrimary ||
      event.button !== 0
    ) {
      return;
    }
    cleanup();
    const start = { x: event.clientX, y: event.clientY };
    const handle = event.currentTarget;
    const destinations = new Map(
      optionsRef.current.destinations.map((destination) => [destination.key, destination]),
    );
    const gesture: TouchBoardGesture = {
      activated: false,
      completed: false,
      destinations,
      frame: null,
      handle,
      keydown: (keyboardEvent) => {
        if (keyboardEvent.key === 'Escape') cancelActive(true);
      },
      orientationChange: () => cancelActive(true),
      overKey: null,
      point: start,
      pointerId: event.pointerId,
      sourceColumn: optionsRef.current.sourceColumn,
      start,
      startedAt: performance.now(),
      timer: null,
      validKeys: new Set(destinations.keys()),
      viewport: handle.closest<HTMLElement>('.status-board-viewport'),
    };
    gestureRef.current = gesture;
    const activate = () => {
      if (
        gestureRef.current !== gesture ||
        exceedsTouchBoardSlop(gesture.start, gesture.point)
      ) {
        return;
      }
      const elapsed = performance.now() - gesture.startedAt;
      if (!shouldActivateTouchBoardDrag(elapsed, gesture.start, gesture.point)) {
        gesture.timer = window.setTimeout(activate, Math.max(1, Math.ceil(TOUCH_BOARD_LONG_PRESS_MS - elapsed)));
        return;
      }
      gesture.timer = null;
      gesture.activated = true;
      try {
        handle.setPointerCapture(gesture.pointerId);
      } catch {
        cancelActive(false);
        return;
      }
      markTouchBoardDestinations(gesture.viewport, gesture.validKeys);
      document.addEventListener('keydown', gesture.keydown);
      window.addEventListener('orientationchange', gesture.orientationChange);
      window.addEventListener('resize', gesture.orientationChange);
      setVisual({
        orderNumber: optionsRef.current.orderNumber,
        statusName: optionsRef.current.statusName,
        x: gesture.point.x,
        y: gesture.point.y,
      });
      optionsRef.current.onAnnounce(
        `Заказ ${optionsRef.current.orderNumber} поднят. Перетащите в доступный статус.`,
      );
      try {
        navigator.vibrate?.(18);
      } catch {
        // Vibration is optional and can be blocked by device policy.
      }
      startAutoScroll(gesture);
    };
    gesture.timer = window.setTimeout(activate, TOUCH_BOARD_LONG_PRESS_MS);
  }, [cancelActive, cleanup, startAutoScroll]);

  const onPointerMove = useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.point = { x: event.clientX, y: event.clientY };
    if (!gesture.activated) {
      if (exceedsTouchBoardSlop(gesture.start, gesture.point)) cleanup();
      return;
    }
    event.preventDefault();
    updateOverColumn(gesture);
    setVisual((current) => current ? { ...current, x: event.clientX, y: event.clientY } : current);
  }, [cleanup, updateOverColumn]);

  const onPointerUp = useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    const gesture = gestureRef.current;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    if (!gesture.activated) {
      cleanup();
      return;
    }
    event.preventDefault();
    gesture.point = { x: event.clientX, y: event.clientY };
    updateOverColumn(gesture);
    const claim = claimTouchBoardDrop(
      gesture.completed,
      gesture.overKey,
      gesture.sourceColumn,
      gesture.validKeys,
    );
    gesture.completed = claim.completed;
    const destination = claim.targetKey
      ? gesture.destinations.get(claim.targetKey) ?? null
      : null;
    const trigger = gesture.handle;
    suppressClickUntilRef.current = Date.now() + TOUCH_CLICK_SUPPRESSION_MS;
    cleanup();
    if (!destination) {
      optionsRef.current.onAnnounce(`Перемещение заказа ${optionsRef.current.orderNumber} отменено.`);
      return;
    }
    optionsRef.current.onAnnounce(
      `Заказ ${optionsRef.current.orderNumber} перемещается в статус ${destination.statusName}.`,
    );
    optionsRef.current.onDrop(destination, trigger);
  }, [cleanup, updateOverColumn]);

  const onPointerCancel = useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    if (gestureRef.current?.pointerId === event.pointerId) cancelActive(true);
  }, [cancelActive]);

  const onLostPointerCapture = useCallback<React.PointerEventHandler<HTMLElement>>((event) => {
    if (gestureRef.current?.pointerId === event.pointerId) cancelActive(true);
  }, [cancelActive]);

  const onClickCapture = useCallback<React.MouseEventHandler<HTMLElement>>((event) => {
    if (Date.now() >= suppressClickUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!options.enabled) cancelActive(false);
  }, [cancelActive, options.enabled]);

  useEffect(() => () => cleanup(), [cleanup]);

  const ghost = visual && typeof document !== 'undefined'
    ? createPortal(
      <div
        className="status-board-touch-ghost"
        data-testid="status-board-touch-ghost"
        style={{ left: visual.x, top: visual.y }}
        aria-hidden="true"
      >
        <strong>{visual.orderNumber}</strong>
        <span>{visual.statusName}</span>
      </div>,
      document.body,
    )
    : null;

  return {
    active: visual !== null,
    ghost,
    handleProps: {
      onClickCapture,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
    },
  };
}
