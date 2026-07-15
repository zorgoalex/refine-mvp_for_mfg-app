import type { SheetPlacementPiece } from '../../api/types/cutApi.types';
import { rotatePiece } from './cutLayoutGeometry';

export interface PieceRef {
  item_id: string;
  instance: number;
}

export const pieceKey = (p: PieceRef): string => `${p.item_id}:${p.instance}`;

/** Editor-session piece groups: groupId -> member keys (>=2), all on ONE sheet. */
export type PieceGroups = Map<number, string[]>;

export function groupOfPiece(groups: PieceGroups, key: string): number | null {
  for (const [groupId, members] of groups) {
    if (members.includes(key)) return groupId;
  }
  return null;
}

/** Axis-aligned bbox over pieces (x_mm/y_mm/width_mm/height_mm), usable-area coords. */
export function groupBBox(pieces: SheetPlacementPiece[]): { x: number; y: number; w: number; h: number } {
  if (pieces.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = pieces[0].x_mm;
  let minY = pieces[0].y_mm;
  let maxX = pieces[0].x_mm + pieces[0].width_mm;
  let maxY = pieces[0].y_mm + pieces[0].height_mm;
  for (let i = 1; i < pieces.length; i += 1) {
    const piece = pieces[i];
    minX = Math.min(minX, piece.x_mm);
    minY = Math.min(minY, piece.y_mm);
    maxX = Math.max(maxX, piece.x_mm + piece.width_mm);
    maxY = Math.max(maxY, piece.y_mm + piece.height_mm);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Clamp a drag delta so EVERY member stays inside the usable area WxH. */
export function clampGroupDelta(args: {
  members: SheetPlacementPiece[];
  dxMm: number;
  dyMm: number;
  usableW: number;
  usableH: number;
}): { dxMm: number; dyMm: number } {
  const { members, dxMm, dyMm, usableW, usableH } = args;
  if (members.length === 0) return { dxMm, dyMm };
  const bbox = groupBBox(members);
  const minDx = -bbox.x;
  const maxDx = usableW - (bbox.x + bbox.w);
  const minDy = -bbox.y;
  const maxDy = usableH - (bbox.y + bbox.h);
  return {
    dxMm: Math.max(minDx, Math.min(maxDx, dxMm)),
    dyMm: Math.max(minDy, Math.min(maxDy, dyMm)),
  };
}

/**
 * Rotate a set of pieces 90° CW as a rigid unit around their bbox.
 * The rotated bbox stays anchored at the original bbox top-left, then shifts
 * minimally to fit the usable area.
 */
export function rotateGroup90(args: {
  members: SheetPlacementPiece[];
  usableW: number;
  usableH: number;
}): SheetPlacementPiece[] | null {
  const { members, usableW, usableH } = args;
  if (members.length === 0) return [];
  const bbox = groupBBox(members);
  const rotatedBBoxW = bbox.h;
  const rotatedBBoxH = bbox.w;
  if (rotatedBBoxW > usableW || rotatedBBoxH > usableH) return null;

  const targetX = Math.max(0, Math.min(usableW - rotatedBBoxW, bbox.x));
  const targetY = Math.max(0, Math.min(usableH - rotatedBBoxH, bbox.y));
  const shiftX = targetX - bbox.x;
  const shiftY = targetY - bbox.y;

  return members.map((member) => {
    const rx = member.x_mm - bbox.x;
    const ry = member.y_mm - bbox.y;
    const rotated = rotatePiece(member);
    return {
      ...rotated,
      x_mm: bbox.x + (bbox.h - ry - member.height_mm) + shiftX,
      y_mm: bbox.y + rx + shiftY,
    };
  });
}

/**
 * Drop groups that are no longer coherent: any member missing from the sheets,
 * or members spread across different sheets. Returns the same Map instance when
 * nothing changed.
 */
export function pruneIncoherentGroups(
  groups: PieceGroups,
  sheets: { sheetIndex: number; placements: { pieces: SheetPlacementPiece[] } }[],
): PieceGroups {
  if (groups.size === 0) return groups;

  const pieceSheetIndex = new Map<string, number>();
  for (const sheet of sheets) {
    for (const piece of sheet.placements.pieces) {
      pieceSheetIndex.set(pieceKey(piece), sheet.sheetIndex);
    }
  }

  let changed = false;
  const next = new Map<number, string[]>();
  for (const [groupId, members] of groups) {
    if (members.length < 2) {
      changed = true;
      continue;
    }
    let sheetIndex: number | null = null;
    let coherent = true;
    for (const memberKey of members) {
      const memberSheetIndex = pieceSheetIndex.get(memberKey);
      if (memberSheetIndex == null) {
        coherent = false;
        break;
      }
      if (sheetIndex == null) {
        sheetIndex = memberSheetIndex;
        continue;
      }
      if (sheetIndex !== memberSheetIndex) {
        coherent = false;
        break;
      }
    }
    if (!coherent) {
      changed = true;
      continue;
    }
    next.set(groupId, members);
  }

  return changed ? next : groups;
}
