import { describe, expect, it } from 'vitest';
import type { SheetPlacementPiece } from '../../api/types/cutApi.types';
import {
  clampGroupDelta,
  groupBBox,
  pieceKey,
  pruneIncoherentGroups,
  rotateGroup90,
  type PieceGroups,
} from './pieceGrouping';

function piece(
  item_id: string,
  instance: number,
  x_mm: number,
  y_mm: number,
  width_mm: number,
  height_mm: number,
  rotated = false,
): SheetPlacementPiece {
  return { item_id, instance, x_mm, y_mm, width_mm, height_mm, rotated };
}

describe('groupBBox', () => {
  it('returns an axis-aligned bbox covering all members', () => {
    const bbox = groupBBox([
      piece('det-1', 1, 10, 15, 20, 30),
      piece('det-2', 1, 40, 5, 10, 10),
      piece('det-3', 1, 5, 35, 5, 5),
    ]);
    expect(bbox).toEqual({ x: 5, y: 5, w: 45, h: 40 });
  });
});

describe('clampGroupDelta', () => {
  const members = [
    piece('det-1', 1, 10, 20, 30, 40),
    piece('det-2', 1, 60, 70, 20, 10),
  ];

  it('clamps positive deltas against the extreme right and bottom members', () => {
    expect(
      clampGroupDelta({
        members,
        dxMm: 50,
        dyMm: 50,
        usableW: 100,
        usableH: 100,
      }),
    ).toEqual({ dxMm: 20, dyMm: 20 });
  });

  it('clamps negative deltas against the extreme left and top members', () => {
    expect(
      clampGroupDelta({
        members,
        dxMm: -30,
        dyMm: -40,
        usableW: 100,
        usableH: 100,
      }),
    ).toEqual({ dxMm: -10, dyMm: -20 });
  });

  it('returns zero movement when a member already touches the usable edge', () => {
    expect(
      clampGroupDelta({
        members,
        dxMm: 0,
        dyMm: 15,
        usableW: 80,
        usableH: 80,
      }),
    ).toEqual({ dxMm: 0, dyMm: 0 });
  });
});

describe('rotateGroup90', () => {
  it('rotates a square bbox in place and toggles member rotated flags', () => {
    const rotated = rotateGroup90({
      members: [
        piece('det-1', 1, 10, 20, 10, 20, false),
        piece('det-2', 1, 20, 20, 10, 20, true),
      ],
      usableW: 200,
      usableH: 200,
    });

    expect(rotated).toEqual([
      piece('det-1', 1, 10, 20, 20, 10, true),
      piece('det-2', 1, 10, 30, 20, 10, false),
    ]);
  });

  it('shifts the rotated bbox minimally to fit the usable area', () => {
    const rotated = rotateGroup90({
      members: [
        piece('det-1', 1, 80, 10, 20, 10, false),
        piece('det-2', 1, 80, 20, 10, 20, false),
      ],
      usableW: 100,
      usableH: 80,
    });

    expect(rotated).toEqual([
      piece('det-1', 1, 90, 10, 10, 20, true),
      piece('det-2', 1, 70, 10, 20, 10, true),
    ]);
  });

  it('returns null when the rotated bbox cannot fit the usable area', () => {
    expect(
      rotateGroup90({
        members: [piece('det-1', 1, 0, 0, 40, 80, false), piece('det-2', 1, 45, 0, 45, 10, false)],
        usableW: 60,
        usableH: 70,
      }),
    ).toBeNull();
  });
});

describe('pruneIncoherentGroups', () => {
  function makeGroups(): PieceGroups {
    return new Map<number, string[]>([
      [1, [pieceKey({ item_id: 'det-1', instance: 1 }), pieceKey({ item_id: 'det-2', instance: 1 })]],
      [2, [pieceKey({ item_id: 'det-3', instance: 1 }), pieceKey({ item_id: 'det-4', instance: 1 })]],
    ]);
  }

  const coherentSheets = [
    {
      sheetIndex: 0,
      placements: {
        trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
        sheet_width_mm: 100,
        sheet_height_mm: 100,
        pieces: [
          piece('det-1', 1, 0, 0, 10, 10),
          piece('det-2', 1, 20, 0, 10, 10),
        ],
      },
    },
    {
      sheetIndex: 1,
      placements: {
        trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
        sheet_width_mm: 100,
        sheet_height_mm: 100,
        pieces: [
          piece('det-3', 1, 0, 0, 10, 10),
          piece('det-4', 1, 20, 0, 10, 10),
        ],
      },
    },
  ];

  it('returns the same Map instance when all groups are coherent', () => {
    const groups = makeGroups();
    expect(pruneIncoherentGroups(groups, coherentSheets)).toBe(groups);
  });

  it('drops a group when a member is missing', () => {
    const groups = makeGroups();
    const pruned = pruneIncoherentGroups(groups, [
      coherentSheets[0],
      {
        ...coherentSheets[1],
        placements: {
          ...coherentSheets[1].placements,
          pieces: [piece('det-3', 1, 0, 0, 10, 10)],
        },
      },
    ]);
    expect(pruned).not.toBe(groups);
    expect(pruned).toEqual(
      new Map<number, string[]>([
        [1, [pieceKey({ item_id: 'det-1', instance: 1 }), pieceKey({ item_id: 'det-2', instance: 1 })]],
      ]),
    );
  });

  it('drops a group when its members are split across sheets', () => {
    const groups = makeGroups();
    const pruned = pruneIncoherentGroups(groups, [
      {
        ...coherentSheets[0],
        placements: {
          ...coherentSheets[0].placements,
          pieces: [piece('det-1', 1, 0, 0, 10, 10)],
        },
      },
      {
        ...coherentSheets[1],
        placements: {
          ...coherentSheets[1].placements,
          pieces: [
            piece('det-2', 1, 20, 0, 10, 10),
            piece('det-3', 1, 0, 0, 10, 10),
            piece('det-4', 1, 20, 0, 10, 10),
          ],
        },
      },
    ]);
    expect(pruned).toEqual(
      new Map<number, string[]>([
        [2, [pieceKey({ item_id: 'det-3', instance: 1 }), pieceKey({ item_id: 'det-4', instance: 1 })]],
      ]),
    );
  });
});
