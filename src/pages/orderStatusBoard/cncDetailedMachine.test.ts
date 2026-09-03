import { describe, expect, it } from 'vitest';
import type {
  CncTelegramBathCard,
  CncTelegramPacket,
  CncTelegramPacketItem,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import type { CutResultDto } from '../../api/types/cutApi.types';
import {
  CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM,
  buildCncDetailedMachineSources,
  cncBathDetailHasMachineFile,
  cncMaterialNameIsMdf,
  cncPacketCountsForMdfReadiness,
  cncPacketHasOtherMaterialMarker,
  selectCncMachineResultSheets,
} from './cncDetailedMachine';

describe('CNC detailed machine sources', () => {
  it('accepts both matching IDs regardless of review status, like bath completion', () => {
    const exact = packet({
      items: [packetItem({
        matchStatus: 'matched',
        matchOrderId: 2701,
        matchDetailId: 7001,
      })],
    });
    const conflict = packet({
      packetId: 'packet-conflict',
      items: [packetItem({
        packetItemId: 'item-conflict',
        matchStatus: 'conflict',
        matchOrderId: 2701,
        matchDetailId: 7001,
      })],
    });
    const review = packet({
      packetId: 'packet-review',
      items: [packetItem({
        packetItemId: 'item-review',
        matchStatus: 'needs_review',
        matchOrderId: 2701,
        matchDetailId: 7001,
      })],
    });
    const partial = packet({
      packetId: 'packet-partial',
      items: [packetItem({
        packetItemId: 'item-partial',
        matchStatus: 'matched',
        matchOrderId: null,
        matchDetailId: 7001,
      })],
    });

    const sources = buildCncDetailedMachineSources({
      columns: machineColumns([exact, conflict, review, partial]),
      bath: bath(),
      selectedDetailId: 7001,
      canViewCut: true,
    });

    expect(sources.map((source) => source.packet.packetId)).toEqual([
      'packet-1',
      'packet-conflict',
      'packet-review',
    ]);
    expect(sources[0]).toMatchObject({ matchKind: 'exact', previewKind: 'svg' });
    expect(cncBathDetailHasMachineFile(machineColumns([exact]), bath(), 7001)).toBe(true);
    expect(cncBathDetailHasMachineFile(machineColumns([partial]), bath(), 7001)).toBe(false);
  });

  it('uses server-compatible orientation-normalized OCR tolerance of 3 mm', () => {
    expect(CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM).toBe(3);
    const boundary = packet({
      items: [packetItem({
        source: 'ocr',
        matchStatus: 'unmatched',
        matchOrderId: null,
        matchDetailId: null,
        widthMm: 474,
        heightMm: 500,
      })],
    });
    const outside = packet({
      packetId: 'packet-outside',
      items: [packetItem({
        packetItemId: 'item-outside',
        source: 'ocr',
        matchStatus: 'unmatched',
        matchOrderId: null,
        matchDetailId: null,
        widthMm: 473.99,
        heightMm: 500.01,
      })],
    });

    const sources = buildCncDetailedMachineSources({
      columns: machineColumns([boundary, outside]),
      bath: bath(),
      selectedDetailId: 7001,
      canViewCut: true,
    });

    expect(sources.map((source) => source.packet.packetId)).toEqual(['packet-1']);
    expect(sources[0].matchKind).toBe('fallback');
  });

  it('keeps repeated fallback rows and whole-order completion cards', () => {
    const ambiguousItem = packetItem({
      matchStatus: 'unmatched',
      matchOrderId: null,
      matchDetailId: null,
    });
    const ambiguous = packet({
      items: [
        ambiguousItem,
        { ...ambiguousItem, packetItemId: 'item-2', sourceItemKey: 'source-2' },
      ],
    });
    const wholeOrderOnly = packet({
      packetId: 'packet-whole-order',
      completionStatus: 'completed',
      comments: ['Весь заказ: 2701'],
      items: [packetItem({
        packetItemId: 'other-detail',
        matchStatus: 'matched',
        matchOrderId: 2701,
        matchDetailId: 7999,
      })],
    });

    expect(buildCncDetailedMachineSources({
      columns: machineColumns([ambiguous, wholeOrderOnly]),
      bath: bath(),
      selectedDetailId: 7001,
      canViewCut: true,
    }).map((source) => [source.packet.packetId, source.matchKind])).toEqual([
      ['packet-1', 'fallback'],
      ['packet-whole-order', 'whole_order'],
    ]);
  });

  it('keeps related non-MDF order cards visible but marks only MDF for auto expansion', () => {
    const pending = packet({
      packetId: 'packet-pending-whole-order',
      comments: ['Весь заказ: 2701'],
      items: [],
    });
    const approved = packet({
      packetId: 'packet-approved-whole-order',
      thumbsUp: true,
      comments: ['Весь заказ: 2701'],
      items: [],
    });
    const otherMaterial = packet({
      packetId: 'packet-other-material-whole-order',
      completionStatus: 'completed',
      comments: ['Весь заказ: 2701', 'Материал HDF'],
      items: [],
    });
    const plywoodFilename = packet({
      packetId: 'packet-plywood-filename',
      programName: 'CNC#1_2701-plywood.TXT',
      materialName: 'Не определён',
      items: [],
    });

    const sources = buildCncDetailedMachineSources({
      columns: machineColumns([pending, approved, otherMaterial, plywoodFilename]),
      bath: bath(),
      selectedDetailId: 7001,
      canViewCut: true,
    });

    expect(sources.map((source) => ({
      packetId: source.packet.packetId,
      matchKind: source.matchKind,
      otherMaterial: source.otherMaterial,
      autoExpand: source.autoExpand,
    }))).toEqual([
      {
        packetId: 'packet-approved-whole-order',
        matchKind: 'whole_order',
        otherMaterial: false,
        autoExpand: true,
      },
      {
        packetId: 'packet-other-material-whole-order',
        matchKind: 'order',
        otherMaterial: true,
        autoExpand: false,
      },
      {
        packetId: 'packet-plywood-filename',
        matchKind: 'order',
        otherMaterial: true,
        autoExpand: false,
      },
    ]);
  });

  it('recognizes explicit non-MDF material in material, filename and comments', () => {
    expect(cncPacketHasOtherMaterialMarker(packet({ materialName: 'ХДФ 3 мм' }))).toBe(true);
    expect(cncPacketHasOtherMaterialMarker(packet({ comments: ['ЛДСП белый'] }))).toBe(true);
    expect(cncPacketHasOtherMaterialMarker(packet({ programName: '2701-Фанера.TXT' }))).toBe(true);
    expect(cncPacketHasOtherMaterialMarker(packet({ materialName: 'OSB 12 мм' }))).toBe(true);
    expect(cncPacketHasOtherMaterialMarker(packet({ materialName: 'МДФ / ХДФ' }))).toBe(true);
    expect(cncPacketHasOtherMaterialMarker(packet({ materialName: 'МДФ 16 мм' }))).toBe(false);
    expect(cncPacketHasOtherMaterialMarker(packet({ materialName: 'Не определён' }))).toBe(false);
    expect(cncPacketHasOtherMaterialMarker(packet({ materialName: 'Не определено' }))).toBe(false);
  });

  it('counts only explicit MDF material for cut readiness', () => {
    expect(cncMaterialNameIsMdf('МДФ 16 мм')).toBe(true);
    expect(cncMaterialNameIsMdf('MDF 18')).toBe(true);
    expect(cncMaterialNameIsMdf('ХДФ 3 мм')).toBe(false);
    expect(cncMaterialNameIsMdf('ЛДСП 16 мм')).toBe(false);
    expect(cncMaterialNameIsMdf('Фанера 12 мм')).toBe(false);
    expect(cncMaterialNameIsMdf('Не определён')).toBe(false);
    expect(cncPacketCountsForMdfReadiness(packet({ materialName: 'МДФ 16 мм' }))).toBe(true);
    expect(cncPacketCountsForMdfReadiness(packet({ materialName: 'МДФ / ХДФ' }))).toBe(false);
    expect(cncPacketCountsForMdfReadiness(packet({
      materialName: 'МДФ 16 мм',
      comments: ['ЛДСП белый'],
    }))).toBe(false);
  });

  it('shows cards for every bath detail before a concrete detail is selected', () => {
    const secondDetailPacket = packet({
      packetId: 'packet-second-detail',
      sheetImageUrl: null,
      svgCutJobId: null,
      svgCutResultId: null,
      svgCutResultNo: null,
      svgCutImportStatus: 'none',
      items: [packetItem({
        packetItemId: 'item-second-detail',
        detailNumber: 32,
        matchOrderId: 2701,
        matchDetailId: 7002,
      })],
    });
    const expandedBath = {
      ...bath(),
      items: [
        ...bath().items,
        {
          ...bath().items[0],
          bathItemId: 'bath-item-2',
          detailId: 7002,
          detailNumber: 32,
        },
      ],
    };

    const sources = buildCncDetailedMachineSources({
      columns: machineColumns([packet(), secondDetailPacket]),
      bath: expandedBath,
      selectedDetailId: null,
      canViewCut: true,
    });

    expect(sources.map((source) => source.packet.packetId)).toEqual([
      'packet-1',
      'packet-second-detail',
    ]);
    expect(sources[1].previewKind).toBe('unavailable');
  });

  it('uses imported SVG with cut.view and screenshot fallback without cut.view', () => {
    const columns = machineColumns([packet()]);
    const common = { columns, bath: bath(), selectedDetailId: 7001 };

    expect(buildCncDetailedMachineSources({ ...common, canViewCut: true })[0]).toMatchObject({
      previewKind: 'svg',
      cutJobId: 35,
      resultNo: 3,
    });
    expect(buildCncDetailedMachineSources({ ...common, canViewCut: false })[0]).toMatchObject({
      previewKind: 'screenshot',
      imageUrl: '/api/v1/cnc-telegram/media/sheet.jpg',
      svgPermissionRequired: true,
    });
    expect(buildCncDetailedMachineSources({
      ...common,
      columns: machineColumns([packet({ sheetImageUrl: null })]),
      canViewCut: false,
    })[0]).toMatchObject({
      previewKind: 'unavailable',
      svgPermissionRequired: true,
      cutJobId: null,
      resultNo: null,
    });
  });

  it('keeps every exact related packet in board order for a distributed detail', () => {
    const second = packet({
      packetId: 'packet-2',
      svgCutJobId: 36,
      svgCutResultId: 55,
      svgCutResultNo: 1,
      items: [packetItem({
        packetItemId: 'item-second',
        matchStatus: 'matched',
        matchOrderId: 2701,
        matchDetailId: 7001,
      })],
    });

    const sources = buildCncDetailedMachineSources({
      columns: machineColumns([packet(), second]),
      bath: bath(),
      selectedDetailId: 7001,
      canViewCut: true,
    });

    expect(sources.map((source) => source.packet.packetId)).toEqual(['packet-1', 'packet-2']);
  });
});

describe('CNC detailed machine result sheets', () => {
  it('selects only sheets that contain det-<selectedDetailId> across groups', () => {
    const selected = selectCncMachineResultSheets(cutResult(), 7001);

    expect(selected.map((sheet) => sheet.key)).toEqual([
      '35:3:101:0',
      '35:3:102:2',
    ]);
    expect(selectCncMachineResultSheets(cutResult(), 7999)).toEqual([]);
  });

  it('shows all sheets for imported informative SVG results without order-detail pieces', () => {
    const result = cutResult();
    const informative: CutResultDto = {
      ...result,
      job: {
        ...result.job,
        items: [],
        groups: result.job.groups.map((group) => ({
          ...group,
          sheets: group.sheets.map((sheet) => ({
            ...sheet,
            placements: {
              ...sheet.placements,
              pieces: sheet.placements.pieces.map((piece, index) => ({
                ...piece,
                item_id: `svg-${group.cutGroupId}-${sheet.sheetIndex}-${index + 1}`,
              })),
            },
          })),
        })),
      },
    };

    expect(selectCncMachineResultSheets(informative, 7001).map((sheet) => sheet.key)).toEqual([
      '35:3:101:0',
      '35:3:101:1',
      '35:3:102:2',
    ]);
  });
});

function machineColumns(packets: CncTelegramPacket[]): CncTelegramTodayColumn[] {
  return [{ key: 'parsed', title: 'Файлы на станке', total: packets.length, packets, baths: [] }];
}

function packetItem(overrides: Partial<CncTelegramPacketItem> = {}): CncTelegramPacketItem {
  return {
    packetItemId: 'item-1',
    sourceItemKey: '2701:31:497x477',
    orderName: '2701',
    orderId: 2701,
    detailNumber: 31,
    widthMm: 497,
    heightMm: 477,
    quantity: 1,
    source: 'vector',
    confidence: 1,
    matchOrderId: 2701,
    matchDetailId: 7001,
    matchDetailQuantity: 1,
    matchStatus: 'matched',
    reviewNote: null,
    laminatedOrLater: false,
    ...overrides,
  };
}

function packet(overrides: Partial<CncTelegramPacket> = {}): CncTelegramPacket {
  return {
    packetId: 'packet-1',
    externalPacketKey: 'chat:1:message:1',
    cuttingSequenceNo: 6,
    sourceChatId: '1',
    sourceMessageId: 1,
    sourceThreadId: null,
    sourceVersion: 1,
    sourceCreatedAt: '2026-08-01T08:00:00.000Z',
    sourceUpdatedAt: null,
    workday: '2026-08-01',
    machine: 'CNC#1',
    programName: 'CNC#1_2701.TXT',
    materialName: 'МДФ',
    sheetImageUrl: '/api/v1/cnc-telegram/media/sheet.jpg',
    sheetImageContentType: 'image/jpeg',
    sheetImageSizeBytes: 100,
    parseStatus: 'parsed',
    completionStatus: 'pending',
    thumbsUp: false,
    completedAt: null,
    rework: false,
    comments: [],
    tools: [],
    dowelingLinks: [],
    analysisWarnings: [],
    ocrEngine: null,
    parserVersion: 'v14',
    cutLayout: null,
    svgCutJobId: 35,
    svgCutResultId: 54,
    svgCutResultNo: 3,
    svgCutImportStatus: 'imported',
    svgCutImportNote: null,
    allLinkedOrderDetailsPackedOrLater: false,
    allLinkedOrderDetailsIssuedOrLater: false,
    itemCount: 1,
    itemQuantityTotal: 1,
    updatedAt: '2026-08-01T08:00:00.000Z',
    items: [packetItem()],
    ...overrides,
  };
}

function bath(): CncTelegramBathCard {
  return {
    bathCardId: 'bath-1',
    cutJobId: 20,
    cutResultId: 40,
    resultNo: 2,
    revisionNo: 1,
    cutNumber: 'В-20-2',
    cutJobName: 'Ванна 2701',
    createdAt: '2026-08-01T09:00:00.000Z',
    ready: false,
    orderCount: 1,
    positionCount: 1,
    itemQuantityTotal: 1,
    items: [{
      bathItemId: 'bath-item-1',
      orderId: 2701,
      orderName: '2701',
      detailId: 7001,
      detailNumber: 31,
      widthMm: 497,
      heightMm: 477,
      quantity: 1,
      completedQuantity: 0,
      ready: false,
      laminatedOrLater: false,
    }],
    sheets: [],
  };
}

function cutResult(): CutResultDto {
  const placements = (itemId: string) => ({
    trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
    sheet_width_mm: 2070,
    sheet_height_mm: 2800,
    pieces: [{
      item_id: itemId,
      instance: 1,
      x_mm: 0,
      y_mm: 0,
      width_mm: 100,
      height_mm: 100,
      rotated: false,
    }],
  });
  return {
    cutResultId: 54,
    cutJobId: 35,
    resultNo: 3,
    cutNumber: '35-3',
    resultKind: 'manual',
    sourceJobVersion: 1,
    basedOnResultId: null,
    createdBy: 1,
    createdByName: 'Оператор',
    createdAt: '2026-08-01T08:00:00.000Z',
    totals: { positions: 2, details: 3, area: 1, sheets: 3, materialsCount: 1, filmsCount: 1 },
    isCurrent: true,
    isArchived: false,
    archivedAt: null,
    archivedBy: null,
    renderToken: 'result-54',
    job: {
      cutJobId: 35,
      name: 'CNC#1_2701.TXT',
      status: 'ready',
      source: 'api',
      createdAt: '2026-08-01T08:00:00.000Z',
      version: 1,
      pdfPrewarmState: 'pending',
      paramProfileId: null,
      sheetMaterialTypeId: 1,
      pdfTemplate: 'standard',
      combineFilms: false,
      splitByMaterial: true,
      rotationAllowed: true,
      textureDirection: 'none',
      materialNames: ['МДФ'],
      totals: { positions: 2, details: 3, area: 1, sheets: 3, materialsCount: 1, filmsCount: 1 },
      items: [],
      groups: [
        {
          cutGroupId: 101,
          sheetMaterialTypeId: 1,
          filmId: 1,
          status: 'ready',
          pdfTemplate: 'standard',
          summary: null,
          sheets: [
            { cutGroupSheetId: 1, sheetIndex: 0, pngCacheKey: null, placements: placements('det-7001') },
            { cutGroupSheetId: 2, sheetIndex: 1, pngCacheKey: null, placements: placements('det-7002') },
          ],
        },
        {
          cutGroupId: 102,
          sheetMaterialTypeId: 1,
          filmId: 1,
          status: 'ready',
          pdfTemplate: 'standard',
          summary: null,
          sheets: [
            { cutGroupSheetId: 3, sheetIndex: 2, pngCacheKey: null, placements: placements('det-7001') },
          ],
        },
      ],
    },
  };
}
