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
import { Menu, message } from 'antd';
import type { SheetPlacements, SheetPlacementPiece } from '../../api/types/cutApi.types';
import {
  snapDraggedPiece,
  rotatePiece,
  orientPieceRect,
  usableExtent,
  moveAllowed,
} from './cutLayoutGeometry';
import type { ManualViolation } from './cutLayoutGeometry';
import { buildPieceLabelLines, fitLabelScale, splitDimsLine, LINE1_SCALE } from './pieceLabel';

// ── Props contract ─────────────────────────────────────────────────────────

export interface SheetEditorProps {
  sheets: { sheetIndex: number; placements: SheetPlacements }[];
  gap: { kerfMm: number; spacingMm: number };
  filmTextureByItemId: Map<string, boolean>;
  landscape: boolean;
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

/** Snap threshold (px): snap engages when the nearest candidate is within this many screen pixels. */
const SNAP_THRESHOLD_PX = 10;

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

/**
 * Get the oriented SVG top-left corner of a piece using the shared
 * orientPieceRect transform (Codex R4 MAJOR #4: single canonical transform).
 * Coordinates are in full-sheet space (trim already added).
 */
function orientedOrigin(
  piece: SheetPlacementPiece,
  placements: SheetPlacements,
  landscape: boolean,
): { x: number; y: number } {
  const r = orientPieceRect(
    {
      x: placements.trim_mm.left + piece.x_mm,
      y: placements.trim_mm.top + piece.y_mm,
      w: piece.width_mm,
      h: piece.height_mm,
    },
    placements.sheet_width_mm,
    placements.sheet_height_mm,
    landscape,
  );
  return { x: r.x, y: r.y };
}

/**
 * Invert the orientPieceRect transform to recover piece usable-area coords
 * from a pointer position in the target sheet's SVG space.
 *
 * Portrait:  svgX = trim.left + x_mm,  svgY = trim.top + y_mm
 * Landscape: svgX = sheetH - (trim.top + y_mm + height_mm),  svgY = trim.left + x_mm
 *
 * @param pieceHeightMm  Current piece height (after any rotation), used for landscape inversion.
 */
function svgToUsable(
  svgX: number,
  svgY: number,
  svgOffsetX: number,
  svgOffsetY: number,
  pieceHeightMm: number,
  placements: SheetPlacements,
  landscape: boolean,
): { x_mm: number; y_mm: number } {
  // Piece oriented top-left in SVG space = pointer position minus stored offset
  const ox = svgX - svgOffsetX;
  const oy = svgY - svgOffsetY;
  const trim = placements.trim_mm;
  if (landscape) {
    return {
      x_mm: oy - trim.left,
      y_mm: placements.sheet_height_mm - trim.top - pieceHeightMm - ox,
    };
  }
  return {
    x_mm: ox - trim.left,
    y_mm: oy - trim.top,
  };
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
    onChange,
    violations,
    labelInfoByItemId,
    splitByMaterial,
    combineFilms,
    groupMaterialTypeId,
    groupFilmId,
    pieceMetaByItemId,
  } = props;

  const [selected, setSelected] = useState<SelectedPiece | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [menu, setMenu] = useState<{
    clientX: number;
    clientY: number;
    sheetIndex: number;
    item_id: string;
    instance: number;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  // ── Stable refs for window-level event handlers (avoid re-subscription on every state change) ──
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const landscapeRef = useRef(landscape);
  landscapeRef.current = landscape;
  const gapRef = useRef(gap);
  gapRef.current = gap;
  const filmTextureRef = useRef(filmTextureByItemId);
  filmTextureRef.current = filmTextureByItemId;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

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
    const handleMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;

      const ls = landscapeRef.current;
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
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
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
      const svgPt = clientToSVG(targetSvgEl, e.clientX, e.clientY);

      // Recompute offset when crossing to a new target sheet
      let { svgOffsetX, svgOffsetY } = d;
      if (targetSheetIndex !== d.targetSheetIndex) {
        const currentOrigin = orientedOrigin(
          { ...piece, x_mm: d.currentX_mm, y_mm: d.currentY_mm },
          targetSheet.placements,
          ls,
        );
        svgOffsetX = svgPt.x - currentOrigin.x;
        svgOffsetY = svgPt.y - currentOrigin.y;
      }

      // Convert pointer to usable-area coords on the target sheet
      const raw = svgToUsable(
        svgPt.x,
        svgPt.y,
        svgOffsetX,
        svgOffsetY,
        piece.height_mm,
        targetSheet.placements,
        ls,
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
      );
      const targetSvgDisplayW = Math.min(MAX_SVG_WIDTH_PX, targetOriented.vw);
      const targetMmPerPx = targetOriented.vw / targetSvgDisplayW;

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

    const handleUp = () => {
      const d = dragRef.current;
      if (!d) return;

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
    <div data-testid="sheet-editor" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
      {displaySheets.map(({ sheetIndex, placements }) => {
        const W = placements.sheet_width_mm;
        const H = placements.sheet_height_mm;
        const trim = placements.trim_mm;
        const { usableW, usableH } = usableExtent(placements);

        // Canonical SVG viewBox dimensions: use orientPieceRect on the full sheet rect
        const sheetOriented = orientPieceRect({ x: 0, y: 0, w: W, h: H }, W, H, landscape);
        const vw = sheetOriented.vw;
        const vh = sheetOriented.vh;

        const svgDisplayW = Math.min(MAX_SVG_WIDTH_PX, vw);
        const svgDisplayH = (svgDisplayW / vw) * vh;
        // Conversion factor: how many mm per display pixel at this sheet's scale.
        // Used to keep UI controls (rotate handle, selected stroke) at a fixed
        // SCREEN pixel size regardless of sheet zoom.
        const mmPerPx = vw / svgDisplayW;

        const isDropTarget = drag !== null && drag.targetSheetIndex === sheetIndex;

        return (
          <div key={sheetIndex} data-testid={`sheet-editor-sheet-${sheetIndex}`} style={{ display: 'inline-block', verticalAlign: 'top' }}>
            <div
              style={{
                marginBottom: 4,
                fontSize: 12,
                color: '#595959',
                fontWeight: 600,
              }}
            >
              Лист {sheetIndex + 1}
            </div>

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
                const usableRect = orientPieceRect(
                  { x: trim.left, y: trim.top, w: usableW, h: usableH },
                  W,
                  H,
                  landscape,
                );
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
                  const g = orientPieceRect(
                    { x: trim.left + gx - strokeMm / 2, y: trim.top, w: strokeMm, h: usableH },
                    W, H, landscape,
                  );
                  guides.push(<rect key="gx" x={g.x} y={g.y} width={g.w} height={g.h} fill="#1677ff" opacity={0.7} pointerEvents="none" />);
                }
                if (drag.guideYmm !== null) {
                  const gy = Math.max(0, Math.min(usableH, drag.guideYmm));
                  const g = orientPieceRect(
                    { x: trim.left, y: trim.top + gy - strokeMm / 2, w: usableW, h: strokeMm },
                    W, H, landscape,
                  );
                  guides.push(<rect key="gy" x={g.x} y={g.y} width={g.w} height={g.h} fill="#1677ff" opacity={0.7} pointerEvents="none" />);
                }
                return <>{guides}</>;
              })()}

              {/* Pieces */}
              {placements.pieces.map((piece) => {
                // Apply canonical orientation transform (shared, matches preview renderer)
                const r = orientPieceRect(
                  {
                    x: trim.left + piece.x_mm,
                    y: trim.top + piece.y_mm,
                    w: piece.width_mm,
                    h: piece.height_mm,
                  },
                  W,
                  H,
                  landscape,
                );

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
                  widthMm: piece.width_mm,
                  heightMm: piece.height_mm,
                });
                // Base font capped to fit the piece; auto-shrink further if needed.
                // line1Scale accounts for the order-name line being LINE1_SCALE× larger.
                const baseFont = Math.max(4, Math.min(r.w, r.h) * 0.25);
                const labelScale = fitLabelScale({ lines: labelLines, boxW: r.w, boxH: r.h, baseFont, line1Scale: LINE1_SCALE });
                const fontSize = baseFont * labelScale;
                // Vertical positions: block of (L0_tall, L1, L2) centered at cy.
                // L0 height = fontSize * LINE1_SCALE * 1.2; L1/L2 height = fontSize * 1.2.
                const lineH = fontSize * 1.2;
                const font0 = fontSize * LINE1_SCALE;

                return (
                  <g
                    key={pKey(piece.item_id, piece.instance)}
                    data-testid={`piece-${sheetIndex}-${piece.item_id}-${piece.instance}`}
                    opacity={isDraggingThis ? 0.45 : 1}
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
                      const svgEl = svgRefsMap.current.get(sheetIndex);
                      if (!svgEl) return;
                      const pt = clientToSVG(svgEl, e.clientX, e.clientY);
                      const origin = orientedOrigin(piece, placements, landscape);
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
                          {/* L0: order name — large + bold */}
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
  );
}
