/**
 * SheetEditor — interactive SVG editor for a cut group's sheets.
 *
 * Each sheet is rendered as an SVG (viewBox in mm). Operators can:
 *   - Drag pieces across sheets (pointer events, pointer capture via window listeners).
 *   - Rotate pieces 90° via the rotate button on a selected piece or the 'R' key.
 *   - See violation highlights (red) passed in from the parent via `violations` prop.
 *
 * Geometry: all math goes through cutLayoutGeometry (snapDraggedPiece, rotatePiece,
 * orientPieceRect, usableExtent) — no inline geometry literals.
 *
 * Mutations are immutable: props.onChange(nextSheets) is called on pointer-up (commit)
 * or on rotate. The parent re-runs validation and passes fresh violations back down.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Menu, Space, Tooltip, message } from 'antd';
import { MinusOutlined, PlusOutlined, RotateLeftOutlined, RotateRightOutlined } from '@ant-design/icons';
import type { SheetPlacements, SheetPlacementPiece } from '../../api/types/cutApi.types';
import {
  snapDraggedPiece,
  rotatePiece,
  orientPieceRect,
  applyAxisOrigin,
  usableExtent,
  moveAllowed,
} from './cutLayoutGeometry';
import type { CutAxisOrigin, ManualViolation } from './cutLayoutGeometry';
import { orientedOrigin, svgToUsable } from './sheetEditorGeometry';
import { buildPieceLabelLines, fitLabelScale, splitDimsLine, LINE1_SCALE } from './pieceLabel';
import { sheetMaterialFilmNames } from './cutPageHelpers';

// ── Props contract ─────────────────────────────────────────────────────────

export interface SheetEditorProps {
  sheets: { sheetIndex: number; placements: SheetPlacements }[];
  gap: { kerfMm: number; spacingMm: number };
  filmTextureByItemId: Map<string, boolean>;
  landscape: boolean;
  /** When rotated, anchor the dense cluster at the view's top-left (transpose)
   *  instead of the legacy 90° CW top-right. Must match the preview/render so the
   *  editor and the sheet cards show the same orientation. Default false. */
  originTopLeft?: boolean;
  axisOrigin?: CutAxisOrigin;
  onChange: (sheets: SheetEditorProps['sheets']) => void;
  violations: ManualViolation[];
  /**
   * Label info keyed by piece.item_id (e.g. "det-42").
   * Provides orderName, orderId, detailNumber and qty for the 3-line piece label.
   * Falls back to piece.label when an item_id is absent from the map.
   */
  labelInfoByItemId: Map<string, { orderName: string | null; orderId: number | null; detailNumber: number | null; qty: number | null }>;
  /** Job-level flag: when true, pieces from different materials cannot share a sheet. */
  splitByMaterial: boolean;
  /** Job-level flag: when false, pieces with different films cannot share a sheet. */
  combineFilms: boolean;
  /** The target group's sheet material type id (null = no spec). */
  groupMaterialTypeId: number | null;
  /** The target group's film id (null = no film). */
  groupFilmId: number | null;
  /** item_id ("det-<id>") → its detail's material/film for cross-sheet guard. */
  pieceMetaByItemId: Map<string, { materialTypeId: number | null; filmId: number | null }>;
  /** item_id ("det-<id>") → sheet-material and film NAMES for the per-sheet header. */
  pieceSheetInfoByItemId: Map<string, { materialName: string | null; filmName: string | null }>;
  /** Show per-sheet film name(s) — true when the job splits by film (combineFilms off). */
  showFilm: boolean;
}

// ── Internal types ─────────────────────────────────────────────────────────

interface SelectedPiece {
  sheetIndex: number;
  item_id: string;
  instance: number;
}

interface DragState {
  /** The sheet the piece started on. */
  sourceSheetIndex: number;
  /** The sheet the piece is currently hovering over (may differ from source). */
  targetSheetIndex: number;
  item_id: string;
  instance: number;
  /** Piece's current x_mm within the TARGET sheet's usable area. */
  currentX_mm: number;
  /** Piece's current y_mm within the TARGET sheet's usable area. */
  currentY_mm: number;
  /** Offset (pointer − piece oriented top-left) in the target sheet's SVG space. */
  svgOffsetX: number;
  svgOffsetY: number;
  /** Snap guide coordinate in mm along the X axis (null = no snap active on X). */
  guideXmm: number | null;
  /** Snap guide coordinate in mm along the Y axis (null = no snap active on Y). */
  guideYmm: number | null;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Maximum display width (px) of a single sheet SVG. */
const MAX_SVG_WIDTH_PX = 700;

const MIN_VIEW_ZOOM = 0.25;
const MAX_VIEW_ZOOM = 1.5;
const VIEW_ZOOM_STEP = 0.25;

/** Snap threshold (px): snap engages when the nearest candidate is within this many screen pixels. */
const SNAP_THRESHOLD_PX = 10;

/** Edge band that starts scrolling while dragging a piece across a tall sheet group. */
const DRAG_SCROLL_ZONE_PX = 96;

/** Max autoscroll speed while dragging near an edge. */
const DRAG_SCROLL_MAX_PX_PER_FRAME = 18;

/** SVG labels must fit actual oriented piece bounds; allow stronger shrink than preview HTML. */
const SVG_LABEL_MIN_SCALE = 0.05;

// ── Pure helpers ───────────────────────────────────────────────────────────

function pKey(item_id: string, instance: number): string {
  return `${item_id}:${instance}`;
}

/**
 * Convert client coordinates to SVG viewBox coordinates using the SVG's
 * current transformation matrix (getScreenCTM), falling back to a simple
 * bounding-rect ratio if the CTM is unavailable.
 */
function clientToSVG(
  svgEl: SVGSVGElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const pt = svgEl.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svgEl.getScreenCTM();
  if (ctm) {
    const sp = pt.matrixTransform(ctm.inverse());
    return { x: sp.x, y: sp.y };
  }
  // Fallback: linear scale from bounding rect
  const rect = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox.baseVal;
  return {
    x: ((clientX - rect.left) / rect.width) * vb.width,
    y: ((clientY - rect.top) / rect.height) * vb.height,
  };
}

/** Current uniform SVG scale in viewBox millimetres per screen pixel. */
function svgMmPerScreenPx(svgEl: SVGSVGElement, fallbackViewBoxWidth: number): number {
  const ctm = svgEl.getScreenCTM();
  if (ctm) {
    const screenPxPerMm = Math.hypot(ctm.a, ctm.b);
    if (screenPxPerMm > 0) return 1 / screenPxPerMm;
  }
  return fallbackViewBoxWidth / Math.max(1, svgEl.getBoundingClientRect().width);
}

function clipIdForPiece(sheetIndex: number, itemId: string, instance: number): string {
  return `cut-piece-label-clip-${sheetIndex}-${itemId.replace(/[^a-zA-Z0-9_-]/g, '-')}-${instance}`;
}

function scrollBounds(el: Element): { top: number; bottom: number; canUp: boolean; canDown: boolean; scrollBy: (dy: number) => void } {
  const scrollingElement = document.scrollingElement;
  if (el === scrollingElement) {
    const top = 0;
    const bottom = window.innerHeight;
    const maxScroll = Math.max(0, scrollingElement.scrollHeight - window.innerHeight);
    return {
      top,
      bottom,
      canUp: window.scrollY > 0,
      canDown: window.scrollY < maxScroll,
      scrollBy: (dy) => window.scrollBy(0, dy),
    };
  }
  const htmlEl = el as HTMLElement;
  const rect = htmlEl.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    canUp: htmlEl.scrollTop > 0,
    canDown: htmlEl.scrollTop + htmlEl.clientHeight < htmlEl.scrollHeight - 1,
    scrollBy: (dy) => { htmlEl.scrollTop += dy; },
  };
}

function isScrollableY(el: Element): boolean {
  if (el === document.scrollingElement) return true;
  const htmlEl = el as HTMLElement;
  if (htmlEl.scrollHeight <= htmlEl.clientHeight + 1) return false;
  const overflowY = window.getComputedStyle(htmlEl).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
}

function scrollableParents(el: HTMLElement | null): Element[] {
  const out: Element[] = [];
  let current: HTMLElement | null = el;
  while (current) {
    if (isScrollableY(current)) out.push(current);
    current = current.parentElement;
  }
  if (document.scrollingElement) out.push(document.scrollingElement);
  return out;
}

function edgeScrollDelta(clientY: number, bounds: { top: number; bottom: number; canUp: boolean; canDown: boolean }): number {
  if (clientY <= bounds.top + DRAG_SCROLL_ZONE_PX && bounds.canUp) {
    const distance = Math.max(0, clientY - bounds.top);
    return -DRAG_SCROLL_MAX_PX_PER_FRAME * (1 - Math.min(distance, DRAG_SCROLL_ZONE_PX) / DRAG_SCROLL_ZONE_PX);
  }
  if (clientY >= bounds.bottom - DRAG_SCROLL_ZONE_PX && bounds.canDown) {
    const distance = Math.max(0, bounds.bottom - clientY);
    return DRAG_SCROLL_MAX_PX_PER_FRAME * (1 - Math.min(distance, DRAG_SCROLL_ZONE_PX) / DRAG_SCROLL_ZONE_PX);
  }
  return 0;
}

/** Clamp piece origin so the piece stays within the usable area. */
function clampToUsable(
  x_mm: number,
  y_mm: number,
  pieceW: number,
  pieceH: number,
  placements: SheetPlacements,
): { x_mm: number; y_mm: number } {
  const { usableW, usableH } = usableExtent(placements);
  return {
    x_mm: Math.max(0, Math.min(usableW - pieceW, x_mm)),
    y_mm: Math.max(0, Math.min(usableH - pieceH, y_mm)),
  };
}

/**
 * Build display-only sheet placements by applying the current drag preview.
 * Never mutates props; returns the original array reference when no drag is active.
 */
function buildDisplaySheets(
  sheets: SheetEditorProps['sheets'],
  drag: DragState | null,
): SheetEditorProps['sheets'] {
  if (!drag) return sheets;

  const { sourceSheetIndex, targetSheetIndex, item_id, instance, currentX_mm, currentY_mm } = drag;

  // Find the canonical piece from the source sheet (for dimensions/label)
  const sourcePiece = sheets
    .find((s) => s.sheetIndex === sourceSheetIndex)
    ?.placements.pieces.find((p) => p.item_id === item_id && p.instance === instance);
  if (!sourcePiece) return sheets;

  const movedPiece: SheetPlacementPiece = { ...sourcePiece, x_mm: currentX_mm, y_mm: currentY_mm };

  return sheets.map((s) => {
    if (s.sheetIndex === sourceSheetIndex && sourceSheetIndex !== targetSheetIndex) {
      // Remove from source (cross-sheet drag)
      return {
        ...s,
        placements: {
          ...s.placements,
          pieces: s.placements.pieces.filter(
            (p) => !(p.item_id === item_id && p.instance === instance),
          ),
        },
      };
    }
    if (s.sheetIndex === targetSheetIndex) {
      // Add / update on target
      const otherPieces = s.placements.pieces.filter(
        (p) => !(p.item_id === item_id && p.instance === instance),
      );
      return {
        ...s,
        placements: { ...s.placements, pieces: [...otherPieces, movedPiece] },
      };
    }
    return s;
  });
}

// ── Component ──────────────────────────────────────────────────────────────

export function SheetEditor(props: SheetEditorProps): JSX.Element {
  const {
    sheets,
    gap,
    filmTextureByItemId,
    landscape,
    originTopLeft = false,
    axisOrigin = 'top-left',
    onChange,
    violations,
    labelInfoByItemId,
    splitByMaterial,
    combineFilms,
    groupMaterialTypeId,
    groupFilmId,
    pieceMetaByItemId,
    pieceSheetInfoByItemId,
    showFilm,
  } = props;

  const [selected, setSelected] = useState<SelectedPiece | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [viewZoom, setViewZoom] = useState(1);
  const [sheetRotations, setSheetRotations] = useState<Record<number, number>>({});
  const [menu, setMenu] = useState<{
    clientX: number;
    clientY: number;
    sheetIndex: number;
    item_id: string;
    instance: number;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const editorRootRef = useRef<HTMLDivElement | null>(null);

  const changeViewZoom = useCallback((delta: number) => {
    setViewZoom((current) => Math.max(MIN_VIEW_ZOOM, Math.min(MAX_VIEW_ZOOM, current + delta)));
  }, []);

  const rotateSheetView = useCallback((sheetIndex: number, direction: -1 | 1) => {
    setSheetRotations((current) => ({
      ...current,
      [sheetIndex]: (((current[sheetIndex] ?? 0) + direction * 90) % 360 + 360) % 360,
    }));
  }, []);

  // ── Stable refs for window-level event handlers (avoid re-subscription on every state change) ──
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const landscapeRef = useRef(landscape);
  landscapeRef.current = landscape;
  const originTopLeftRef = useRef(originTopLeft);
  originTopLeftRef.current = originTopLeft;
  const axisOriginRef = useRef(axisOrigin);
  axisOriginRef.current = axisOrigin;
  const gapRef = useRef(gap);
  gapRef.current = gap;
  const filmTextureRef = useRef(filmTextureByItemId);
  filmTextureRef.current = filmTextureByItemId;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const lastPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);

  // Guard ref: keeps cross-sheet move policy current for the window-level handleUp handler.
  const guardRef = useRef({ splitByMaterial, combineFilms, groupMaterialTypeId, groupFilmId, pieceMetaByItemId });
  guardRef.current = { splitByMaterial, combineFilms, groupMaterialTypeId, groupFilmId, pieceMetaByItemId };

  // Ref map: sheetIndex → SVG element (for hit testing during cross-sheet drag)
  const svgRefsMap = useRef<Map<number, SVGSVGElement>>(new Map());

  // Violation lookup set: "sheetIndex:itemId:instance"
  const violationSet = useMemo(
    () => new Set(violations.map((v) => `${v.sheetIndex}:${v.itemId}:${v.instance}`)),
    [violations],
  );

  // Display sheets = props sheets with drag preview applied
  const displaySheets = useMemo(() => buildDisplaySheets(sheets, drag), [sheets, drag]);

  // ── Window-level pointer handlers (registered once; state accessed via refs) ──
  useEffect(() => {
    const updateDragFromClient = (clientX: number, clientY: number) => {
      const d = dragRef.current;
      if (!d) return;

      const ls = landscapeRef.current;
      const otl = originTopLeftRef.current;
      const axis = axisOriginRef.current;
      const currentSheets = sheetsRef.current;
      const currentGap = gapRef.current;
      const gapMm = currentGap.kerfMm + currentGap.spacingMm;

      // Find the canonical piece in the source sheet (for authoritative dimensions)
      const sourceSheet = currentSheets.find((s) => s.sheetIndex === d.sourceSheetIndex);
      if (!sourceSheet) return;
      const piece = sourceSheet.placements.pieces.find(
        (p) => p.item_id === d.item_id && p.instance === d.instance,
      );
      if (!piece) return;

      // Determine which sheet the pointer is over for cross-sheet detection
      let targetSheetIndex = d.targetSheetIndex;
      let targetSvgEl: SVGSVGElement | undefined = svgRefsMap.current.get(d.targetSheetIndex);

      for (const [si, svgEl] of svgRefsMap.current) {
        const rect = svgEl.getBoundingClientRect();
        if (
          clientX >= rect.left &&
          clientX <= rect.right &&
          clientY >= rect.top &&
          clientY <= rect.bottom
        ) {
          targetSheetIndex = si;
          targetSvgEl = svgEl;
          break;
        }
      }
      if (!targetSvgEl) return;

      const targetSheet =
        currentSheets.find((s) => s.sheetIndex === targetSheetIndex) ?? sourceSheet;

      // SVG coordinates in the target sheet's viewBox (mm)
      const svgPt = clientToSVG(targetSvgEl, clientX, clientY);

      // Keep the ORIGINAL grab offset across a sheet crossing. A cut group's
      // sheets share dimensions, trim and orientation, so this offset (viewBox mm)
      // is invariant across them and the piece stays under the cursor at the same
      // grab point on the new sheet
      // (and drops exactly where the pointer is released). Re-anchoring it to the
      // old usable coords here teleported the piece to its source position —
      // typically the sheet's top-left corner.
      const { svgOffsetX, svgOffsetY } = d;

      // Convert pointer to usable-area coords on the target sheet
      const raw = svgToUsable(
        svgPt.x,
        svgPt.y,
        svgOffsetX,
        svgOffsetY,
        piece.height_mm,
        targetSheet.placements,
        ls,
        otl,
        axis,
        piece.width_mm,
      );

      // Other pieces on target (excluding the dragged piece)
      const othersOnTarget = targetSheet.placements.pieces
        .filter((p) => !(p.item_id === d.item_id && p.instance === d.instance))
        .map((p) => ({ x: p.x_mm, y: p.y_mm, w: p.width_mm, h: p.height_mm }));

      const { usableW, usableH } = usableExtent(targetSheet.placements);

      // Compute the target sheet's mm-per-pixel ratio for scale-aware snap threshold.
      const targetOriented = orientPieceRect(
        { x: 0, y: 0, w: targetSheet.placements.sheet_width_mm, h: targetSheet.placements.sheet_height_mm },
        targetSheet.placements.sheet_width_mm,
        targetSheet.placements.sheet_height_mm,
        ls,
        otl,
      );
      const targetMmPerPx = svgMmPerScreenPx(targetSvgEl, targetOriented.vw);

      // Apply snap (shared geometry — no inline math)
      const snapped = snapDraggedPiece({
        rect: { x: raw.x_mm, y: raw.y_mm, w: piece.width_mm, h: piece.height_mm },
        others: othersOnTarget,
        usableW,
        usableH,
        gapMm,
        thresholdMm: SNAP_THRESHOLD_PX * targetMmPerPx,
      });

      const clamped = clampToUsable(
        snapped.x,
        snapped.y,
        piece.width_mm,
        piece.height_mm,
        targetSheet.placements,
      );

      const next: DragState = {
        ...d,
        targetSheetIndex,
        currentX_mm: clamped.x_mm,
        currentY_mm: clamped.y_mm,
        svgOffsetX,
        svgOffsetY,
        guideXmm: snapped.guideX,
        guideYmm: snapped.guideY,
      };
      dragRef.current = next;
      setDrag(next);
    };

    const performDragAutoScroll = () => {
      const pointer = lastPointerRef.current;
      if (!dragRef.current || !pointer) {
        autoScrollFrameRef.current = null;
        return;
      }

      for (const target of scrollableParents(editorRootRef.current)) {
        const bounds = scrollBounds(target);
        const dy = edgeScrollDelta(pointer.clientY, bounds);
        if (dy !== 0) {
          bounds.scrollBy(dy);
          updateDragFromClient(pointer.clientX, pointer.clientY);
          break;
        }
      }
      autoScrollFrameRef.current = window.requestAnimationFrame(performDragAutoScroll);
    };

    const ensureAutoScroll = () => {
      if (autoScrollFrameRef.current === null) {
        autoScrollFrameRef.current = window.requestAnimationFrame(performDragAutoScroll);
      }
    };

    const stopAutoScroll = () => {
      if (autoScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(autoScrollFrameRef.current);
        autoScrollFrameRef.current = null;
      }
      lastPointerRef.current = null;
    };

    const handleMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      lastPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
      updateDragFromClient(e.clientX, e.clientY);
      ensureAutoScroll();
    };

    const handleUp = () => {
      const d = dragRef.current;
      if (!d) return;
      stopAutoScroll();

      const currentSheets = sheetsRef.current;
      const { sourceSheetIndex, targetSheetIndex, item_id, instance, currentX_mm, currentY_mm } = d;

      const sourceSheet = currentSheets.find((s) => s.sheetIndex === sourceSheetIndex);
      if (!sourceSheet) {
        dragRef.current = null;
        setDrag(null);
        return;
      }
      const piece = sourceSheet.placements.pieces.find(
        (p) => p.item_id === item_id && p.instance === instance,
      );
      if (!piece) {
        dragRef.current = null;
        setDrag(null);
        return;
      }

      const updatedPiece: SheetPlacementPiece = { ...piece, x_mm: currentX_mm, y_mm: currentY_mm };

      // Cross-sheet move guard: abort (snap-back) if material or film policy is violated.
      if (targetSheetIndex !== sourceSheetIndex) {
        const g = guardRef.current;
        const meta = g.pieceMetaByItemId.get(item_id) ?? { materialTypeId: null, filmId: null };
        const verdict = moveAllowed({
          pieceMaterialTypeId: meta.materialTypeId,
          pieceFilmId: meta.filmId,
          targetMaterialTypeId: g.groupMaterialTypeId,
          targetFilmId: g.groupFilmId,
          splitByMaterial: g.splitByMaterial,
          combineFilms: g.combineFilms,
        });
        if (!verdict.ok) {
          void message.warning(
            verdict.reason === 'material'
              ? 'Нельзя переместить: другой материал листа'
              : 'Нельзя переместить: другая плёнка (объединение плёнок выключено)',
          );
          dragRef.current = null;
          setDrag(null);
          return; // piece stays on source sheet (snap-back)
        }
      }

      // Build next sheets immutably: move piece from source → target
      const nextSheets = currentSheets.map((s) => {
        if (s.sheetIndex === sourceSheetIndex) {
          const filtered = s.placements.pieces.filter(
            (p) => !(p.item_id === item_id && p.instance === instance),
          );
          if (sourceSheetIndex === targetSheetIndex) filtered.push(updatedPiece);
          return { ...s, placements: { ...s.placements, pieces: filtered } };
        }
        if (s.sheetIndex === targetSheetIndex) {
          return {
            ...s,
            placements: {
              ...s.placements,
              pieces: [...s.placements.pieces, updatedPiece],
            },
          };
        }
        return s;
      });

      onChangeRef.current(nextSheets);
      dragRef.current = null;
      setDrag(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      stopAutoScroll();
    };
  }, []); // Empty deps intentional: all mutable state is accessed through refs above

  // ── Window 'R' key → rotate selected piece ────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'r' && e.key !== 'R') return;
      const sel = selectedRef.current;
      if (!sel) return;
      const currentSheets = sheetsRef.current;
      const sheet = currentSheets.find((s) => s.sheetIndex === sel.sheetIndex);
      if (!sheet) return;
      const piece = sheet.placements.pieces.find(
        (p) => p.item_id === sel.item_id && p.instance === sel.instance,
      );
      if (!piece) return;
      // Grain-lock guard: block rotation for film-textured pieces
      if (filmTextureRef.current.get(piece.item_id) === true) {
        void message.warning('Поворот запрещён: текстура плёнки закреплена');
        return;
      }
      const rotated = rotatePiece(piece);
      onChangeRef.current(
        currentSheets.map((s) => {
          if (s.sheetIndex !== sel.sheetIndex) return s;
          return {
            ...s,
            placements: {
              ...s.placements,
              pieces: s.placements.pieces.map((p) =>
                p.item_id === piece.item_id && p.instance === piece.instance ? rotated : p,
              ),
            },
          };
        }),
      );
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []); // Empty deps intentional: all mutable state is accessed through refs above

  // ── Close context menu on outside interaction ─────────────────────────────
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    const onAny = () => setMenu(null);
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onAny);
    window.addEventListener('scroll', onAny, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onAny);
      window.removeEventListener('scroll', onAny, true);
    };
  }, [menu]);

  // ── Rotate button handler ─────────────────────────────────────────────────
  const handleRotateButton = useCallback(
    (sheetIndex: number, item_id: string, instance: number) => {
      const sheet = sheets.find((s) => s.sheetIndex === sheetIndex);
      if (!sheet) return;
      const piece = sheet.placements.pieces.find(
        (p) => p.item_id === item_id && p.instance === instance,
      );
      if (!piece) return;
      if (filmTextureByItemId.get(piece.item_id) === true) {
        void message.warning('Поворот запрещён: текстура плёнки закреплена');
        return;
      }
      const rotated = rotatePiece(piece);
      onChange(
        sheets.map((s) => {
          if (s.sheetIndex !== sheetIndex) return s;
          return {
            ...s,
            placements: {
              ...s.placements,
              pieces: s.placements.pieces.map((p) =>
                p.item_id === item_id && p.instance === instance ? rotated : p,
              ),
            },
          };
        }),
      );
    },
    [sheets, filmTextureByItemId, onChange],
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div ref={editorRootRef} data-testid="sheet-editor">
      <Space size={4} style={{ marginBottom: 12 }} data-testid="sheet-editor-zoom-controls">
        <Tooltip title="Уменьшить масштаб группы раскроя">
          <Button
            aria-label="Уменьшить масштаб группы раскроя"
            icon={<MinusOutlined />}
            style={{ width: 40, height: 40 }}
            disabled={viewZoom <= MIN_VIEW_ZOOM}
            onClick={() => changeViewZoom(-VIEW_ZOOM_STEP)}
          />
        </Tooltip>
        <span
          data-testid="sheet-editor-zoom-value"
          style={{ minWidth: 52, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
        >
          {Math.round(viewZoom * 100)}%
        </span>
        <Tooltip title="Увеличить масштаб группы раскроя">
          <Button
            aria-label="Увеличить масштаб группы раскроя"
            icon={<PlusOutlined />}
            style={{ width: 40, height: 40 }}
            disabled={viewZoom >= MAX_VIEW_ZOOM}
            onClick={() => changeViewZoom(VIEW_ZOOM_STEP)}
          />
        </Tooltip>
      </Space>
      <div
      // Disable native text selection / drag-image. Grabbing a piece must not let
      // the browser start a text selection over the SVG <text> labels — that
      // produced a translucent "phantom" layer of all the sheet's label text
      // dragging with the cursor while the real piece stayed put (intermittent,
      // browser-dependent). userSelect:none + a prevented dragstart kill it.
      onDragStart={(e) => e.preventDefault()}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        alignItems: 'flex-start',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        msUserSelect: 'none',
        MozUserSelect: 'none',
      }}
    >
      {displaySheets.map(({ sheetIndex, placements }, sheetPos) => {
        const W = placements.sheet_width_mm;
        const H = placements.sheet_height_mm;
        const trim = placements.trim_mm;
        const { usableW, usableH } = usableExtent(placements);

        // Canonical SVG viewBox dimensions: use orientPieceRect on the full sheet rect
        const sheetOriented = orientPieceRect({ x: 0, y: 0, w: W, h: H }, W, H, landscape, originTopLeft);
        const vw = sheetOriented.vw;
        const vh = sheetOriented.vh;

        const svgDisplayW = Math.min(MAX_SVG_WIDTH_PX, vw) * viewZoom;
        const svgDisplayH = (svgDisplayW / vw) * vh;
        // Conversion factor: how many mm per display pixel at this sheet's scale.
        // Used to keep UI controls (rotate handle, selected stroke) at a fixed
        // SCREEN pixel size regardless of sheet zoom.
        const mmPerPx = vw / svgDisplayW;

        const isDropTarget = drag !== null && drag.targetSheetIndex === sheetIndex;
        const viewRotation = sheetRotations[sheetIndex] ?? 0;
        const swapsViewAxes = viewRotation % 180 !== 0;
        const rotatedViewportW = swapsViewAxes ? svgDisplayH : svgDisplayW;
        const rotatedViewportH = swapsViewAxes ? svgDisplayW : svgDisplayH;

        return (
          <div key={sheetIndex} data-testid={`sheet-editor-sheet-${sheetIndex}`} style={{ display: 'inline-block', verticalAlign: 'top' }}>
            {(() => {
              // Per-sheet material (always) and film (only when the job splits by
              // film) resolved from the pieces actually on this sheet — all on one
              // line with the sheet number and detail count.
              const { materials, films } = sheetMaterialFilmNames(
                placements.pieces,
                pieceSheetInfoByItemId,
                showFilm,
              );
              return (
                <div
                  style={{
                    marginBottom: 4,
                    fontSize: 12,
                    color: '#595959',
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span>
                    Лист {sheetPos + 1} · дет. {placements.pieces.length}
                    {materials.length > 0 && (
                      <>
                        {' · '}
                        {materials.length > 1 ? 'Материалы' : 'Материал'}: <b>{materials.join(', ')}</b>
                      </>
                    )}
                    {films.length > 0 && (
                      <>
                        {' · '}
                        {films.length > 1 ? 'Плёнки' : 'Плёнка'}: <b>{films.join(', ')}</b>
                      </>
                    )}
                  </span>
                  <Space size={2}>
                    <Tooltip title="Повернуть лист против часовой стрелки">
                      <Button
                        aria-label={`Повернуть лист ${sheetPos + 1} против часовой стрелки`}
                        icon={<RotateLeftOutlined />}
                        style={{ width: 40, height: 40 }}
                        onClick={() => rotateSheetView(sheetIndex, -1)}
                      />
                    </Tooltip>
                    <Tooltip title="Повернуть лист по часовой стрелке">
                      <Button
                        aria-label={`Повернуть лист ${sheetPos + 1} по часовой стрелке`}
                        icon={<RotateRightOutlined />}
                        style={{ width: 40, height: 40 }}
                        onClick={() => rotateSheetView(sheetIndex, 1)}
                      />
                    </Tooltip>
                  </Space>
                </div>
              );
            })()}

            <div
              style={{
                width: rotatedViewportW,
                height: rotatedViewportH,
                position: 'relative',
                transitionProperty: 'width, height',
                transitionDuration: '160ms',
              }}
            >
            <svg
              ref={(el) => {
                if (el) svgRefsMap.current.set(sheetIndex, el);
                else svgRefsMap.current.delete(sheetIndex);
              }}
              viewBox={`0 0 ${vw} ${vh}`}
              width={svgDisplayW}
              height={svgDisplayH}
              style={{
                border: '1px solid #d9d9d9',
                background: isDropTarget ? '#f0f5ff' : '#fff',
                cursor: drag ? 'grabbing' : 'default',
                display: 'block',
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: `translate(-50%, -50%) rotate(${viewRotation}deg)`,
                transitionProperty: 'transform, width, height',
                transitionDuration: drag ? '0ms' : '160ms',
              }}
              onPointerDown={(e) => {
                // Click on the bare svg (no overlapping element) deselects.
                if (e.target === e.currentTarget) setSelected(null);
              }}
            >
              {/* Sheet background — clicking empty area deselects the current piece.
                  Piece <g> handlers stopPropagation, so this only fires on empty space. */}
              <rect
                x={0}
                y={0}
                width={vw}
                height={vh}
                fill="#fff"
                onPointerDown={() => setSelected(null)}
              />

              {/* Usable-area boundary (dashed rectangle inside trim margins) */}
              {(() => {
                const usableRect = applyAxisOrigin(orientPieceRect(
                  { x: trim.left, y: trim.top, w: usableW, h: usableH },
                  W,
                  H,
                  landscape,
                  originTopLeft,
                ), axisOrigin, landscape);
                return (
                  <rect
                    x={usableRect.x}
                    y={usableRect.y}
                    width={usableRect.w}
                    height={usableRect.h}
                    fill="#fafafa"
                    stroke="#bfbfbf"
                    strokeWidth={0.5}
                    strokeDasharray="4 2"
                    onPointerDown={() => setSelected(null)}
                  />
                );
              })()}

              {/* Snap guide lines — shown only on the drop-target sheet while dragging */}
              {isDropTarget && drag && (drag.guideXmm !== null || drag.guideYmm !== null) && (() => {
                const strokeMm = mmPerPx; // ~1px on screen
                const guides: JSX.Element[] = [];
                if (drag.guideXmm !== null) {
                  const gx = Math.max(0, Math.min(usableW, drag.guideXmm));
                  const g = applyAxisOrigin(orientPieceRect(
                    { x: trim.left + gx - strokeMm / 2, y: trim.top, w: strokeMm, h: usableH },
                    W, H, landscape, originTopLeft,
                  ), axisOrigin, landscape);
                  guides.push(<rect key="gx" x={g.x} y={g.y} width={g.w} height={g.h} fill="#1677ff" opacity={0.7} pointerEvents="none" />);
                }
                if (drag.guideYmm !== null) {
                  const gy = Math.max(0, Math.min(usableH, drag.guideYmm));
                  const g = applyAxisOrigin(orientPieceRect(
                    { x: trim.left, y: trim.top + gy - strokeMm / 2, w: usableW, h: strokeMm },
                    W, H, landscape, originTopLeft,
                  ), axisOrigin, landscape);
                  guides.push(<rect key="gy" x={g.x} y={g.y} width={g.w} height={g.h} fill="#1677ff" opacity={0.7} pointerEvents="none" />);
                }
                return <>{guides}</>;
              })()}

              {/* Pieces */}
              {placements.pieces.map((piece) => {
                // Apply canonical orientation transform (shared, matches preview renderer)
                const r = applyAxisOrigin(orientPieceRect(
                  {
                    x: trim.left + piece.x_mm,
                    y: trim.top + piece.y_mm,
                    w: piece.width_mm,
                    h: piece.height_mm,
                  },
                  W,
                  H,
                  landscape,
                  originTopLeft,
                ), axisOrigin, landscape);

                const isSelected =
                  selected?.sheetIndex === sheetIndex &&
                  selected?.item_id === piece.item_id &&
                  selected?.instance === piece.instance;

                const isDraggingThis =
                  drag !== null &&
                  drag.item_id === piece.item_id &&
                  drag.instance === piece.instance &&
                  drag.targetSheetIndex === sheetIndex;

                const isViolating = violationSet.has(
                  `${sheetIndex}:${piece.item_id}:${piece.instance}`,
                );

                // Visual style: violations take priority (red), then selection (blue), then default
                const fillColor = isViolating ? '#fff1f0' : '#e6f4ff';
                const strokeColor = isViolating ? '#ff4d4f' : isSelected ? '#1677ff' : '#91caff';
                // Scale stroke width so it renders at a fixed screen pixel size.
                // Selected/violating: ~2px on screen; default: ~0.8px.
                const strokeWidth = (isViolating || isSelected ? 2 : 0.8) * mmPerPx;

                // 3-line auto-shrink label: resolve label info from the prop map,
                // falling back to the frozen piece.label snapshot.
                const labelInfo = labelInfoByItemId.get(piece.item_id);
                const labelLines = buildPieceLabelLines({
                  orderName: labelInfo?.orderName ?? null,
                  orderId: labelInfo?.orderId ?? piece.label?.orderId ?? null,
                  detailNumber: labelInfo?.detailNumber ?? piece.label?.detailNumber ?? null,
                  instance: piece.instance,
                  qty: labelInfo?.qty ?? null,
                  widthMm: piece.label?.widthMm ?? piece.width_mm,
                  heightMm: piece.label?.heightMm ?? piece.height_mm,
                });
                // Base font capped to fit the piece; auto-shrink further if needed.
                // line1Scale accounts for the order-name line being LINE1_SCALE× larger.
                const baseFont = Math.max(4, Math.min(r.w, r.h) * 0.25);
                const labelPad = Math.max(mmPerPx * 2, Math.min(r.w, r.h) * 0.03);
                const labelBoxW = Math.max(1, r.w - labelPad * 2);
                const labelBoxH = Math.max(1, r.h - labelPad * 2);
                const labelScale = fitLabelScale({
                  lines: labelLines,
                  boxW: labelBoxW,
                  boxH: labelBoxH,
                  baseFont,
                  minScale: SVG_LABEL_MIN_SCALE,
                  line1Scale: LINE1_SCALE,
                });
                const fontSize = baseFont * labelScale;
                // Vertical positions: block of (L0_tall, L1, L2) centered at cy.
                // L0 height = fontSize * LINE1_SCALE * 1.2; L1/L2 height = fontSize * 1.2.
                const lineH = fontSize * 1.2;
                const font0 = fontSize * LINE1_SCALE;

                return (
                  <g
                    key={pKey(piece.item_id, piece.instance)}
                    data-testid={`piece-${sheetIndex}-${piece.item_id}-${piece.instance}`}
                    opacity={isDraggingThis ? 0.75 : 1}
                    style={{ cursor: drag ? 'grabbing' : 'grab' }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setSelected({ sheetIndex, item_id: piece.item_id, instance: piece.instance });
                      setMenu({ clientX: e.clientX, clientY: e.clientY, sheetIndex, item_id: piece.item_id, instance: piece.instance });
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      setMenu(null);
                      e.stopPropagation();
                      // Prevent the browser from starting a native text selection /
                      // drag of the SVG label text under the pointer (phantom-text drag).
                      e.preventDefault();
                      const svgEl = svgRefsMap.current.get(sheetIndex);
                      if (!svgEl) return;
                      const pt = clientToSVG(svgEl, e.clientX, e.clientY);
                      const origin = orientedOrigin(piece, placements, landscape, originTopLeft, axisOrigin);
                      const sel: SelectedPiece = {
                        sheetIndex,
                        item_id: piece.item_id,
                        instance: piece.instance,
                      };
                      setSelected(sel);
                      const newDrag: DragState = {
                        sourceSheetIndex: sheetIndex,
                        targetSheetIndex: sheetIndex,
                        item_id: piece.item_id,
                        instance: piece.instance,
                        currentX_mm: piece.x_mm,
                        currentY_mm: piece.y_mm,
                        svgOffsetX: pt.x - origin.x,
                        svgOffsetY: pt.y - origin.y,
                        guideXmm: null,
                        guideYmm: null,
                      };
                      dragRef.current = newDrag;
                      setDrag(newDrag);
                    }}
                  >
                    <rect
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      fill={fillColor}
                      stroke={strokeColor}
                      strokeWidth={strokeWidth}
                      data-testid={`piece-rect-${sheetIndex}-${piece.item_id}-${piece.instance}`}
                    />

                    {/* 3-line auto-shrink label — vertically centered on the piece.
                        L0 (order name) renders at font0 = fontSize*LINE1_SCALE (large+bold).
                        L2 (dims) uses tspans to render the '*' at half-size. */}
                    {(() => {
                      const cx = r.x + r.w / 2;
                      const cy = r.y + r.h / 2;
                      const labelClipId = clipIdForPiece(sheetIndex, piece.item_id, piece.instance);
                      const textFill = isViolating ? '#cf1322' : '#1d3557';
                      // Block height = (LINE1_SCALE + 1 + 1) * lineH.
                      // Vertical centers derived from block being centered at cy:
                      //   y0 = cy - lineH
                      //   y1 = cy + lineH * (LINE1_SCALE - 1) / 2
                      //   y2 = cy + lineH * (LINE1_SCALE + 1) / 2
                      const y0 = cy - lineH;
                      const y1 = cy + lineH * (LINE1_SCALE - 1) / 2;
                      const y2 = cy + lineH * (LINE1_SCALE + 1) / 2;
                      const sharedProps = {
                        textAnchor: 'middle' as const,
                        dominantBaseline: 'middle' as const,
                        fill: textFill,
                        pointerEvents: 'none' as const,
                        style: { userSelect: 'none' as const },
                      };
                      const dimsLine = splitDimsLine(labelLines[2]);
                      return (
                        <>
                          <clipPath id={labelClipId} clipPathUnits="userSpaceOnUse">
                            <rect x={r.x + labelPad} y={r.y + labelPad} width={labelBoxW} height={labelBoxH} />
                          </clipPath>
                          {/* L0: order name — large + bold */}
                          <g clipPath={`url(#${labelClipId})`}>
                            <text {...sharedProps} x={cx} y={y0} fontSize={font0} fontWeight={600}>
                              {labelLines[0]}
                            </text>
                            {/* L1: # position · instance/qty */}
                            <text {...sharedProps} x={cx} y={y1} fontSize={fontSize}>
                              {labelLines[1]}
                            </text>
                            {/* L2: dimensions with half-size '*' separator */}
                            <text {...sharedProps} x={cx} y={y2} fontSize={fontSize}>
                              {dimsLine ? (
                                <>
                                  <tspan>{dimsLine.w}</tspan>
                                  <tspan fontSize={fontSize * 0.5}>*</tspan>
                                  <tspan>{dimsLine.h}</tspan>
                                </>
                              ) : labelLines[2]}
                            </text>
                          </g>
                        </>
                      );
                    })()}

                    {/* Rotate control — shown only on the selected piece when not dragging.
                        Sized in FIXED SCREEN PIXELS via mmPerPx so it's always clickable
                        regardless of sheet zoom (a 2800mm sheet at 700px = 4mm/px scale). */}
                    {isSelected && drag === null && (
                      <g
                        transform={`translate(${r.x + r.w - 7 * mmPerPx}, ${r.y + 7 * mmPerPx})`}
                        role="button"
                        aria-label="Повернуть на 90°"
                        data-testid={`rotate-piece-${sheetIndex}-${piece.item_id}-${piece.instance}`}
                        style={{ cursor: 'pointer' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRotateButton(sheetIndex, piece.item_id, piece.instance);
                        }}
                      >
                        {/* Circle center at (0,0); transform moves it to the top-right corner */}
                        <circle cx={0} cy={0} r={7 * mmPerPx} fill="#1677ff" opacity={0.9} />
                        <text
                          x={0}
                          y={0}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fontSize={8 * mmPerPx}
                          fill="#fff"
                          pointerEvents="none"
                          style={{ userSelect: 'none' }}
                        >
                          ↺
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
            </div>
          </div>
        );
      })}
      {menu &&
        createPortal(
          <div
            data-testid="piece-context-menu"
            style={{ position: 'fixed', top: menu.clientY, left: menu.clientX, zIndex: 2000 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Menu
              selectable={false}
              style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.15)', borderRadius: 6 }}
              items={[
                {
                  key: 'rotate',
                  label: 'Поворот',
                  disabled: filmTextureByItemId.get(menu.item_id) === true,
                },
              ]}
              onClick={({ key }) => {
                if (key === 'rotate') {
                  handleRotateButton(menu.sheetIndex, menu.item_id, menu.instance);
                }
                closeMenu();
              }}
            />
          </div>,
          document.body,
        )}
      </div>
    </div>
  );
}
