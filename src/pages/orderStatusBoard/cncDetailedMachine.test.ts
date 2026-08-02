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
  selectCncMachineResultSheets,
} from './cncDetailedMachine';

describe('CNC detailed machine sources', () => {
  it('accepts exact details only with matched status and both matching IDs', () => {
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

    expect(sources.map((source) => source.packet.packetId)).toEqual(['packet-1']);
    expect(sources[0]).toMatchObject({ matchKind: 'exact', previewKind: 'svg' });
  });

  it('allows one unmatched ID-free orientation-normalized fallback within inclusive 1 mm', () => {
    expect(CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM).toBe(1);
    const boundary = packet({
      items: [packetItem({
        matchStatus: 'unmatched',
        matchOrderId: null,
        matchDetailId: null,
        widthMm: 476,
        heightMm: 498,
      })],
    });
    const outside = packet({
      packetId: 'packet-outside',
      items: [packetItem({
        packetItemId: 'item-outside',
        matchStatus: 'unmatched',
        matchOrderId: null,
        matchDetailId: null,
        widthMm: 475.99,
        heightMm: 498.01,
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

  it('rejects ambiguous fallback rows and whole-order comments without a detail match', () => {
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
    })).toEqual([]);
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
    matchStatus: 'matched',
    reviewNote: null,
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
    cutNumber: '20-2',
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
      version: 1,
      pdfPrewarmState: 'pending',
      paramProfileId: null,
      sheetMaterialTypeId: 1,
      pdfTemplate: 'standard',
      combineFilms: false,
      splitByMaterial: true,
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
