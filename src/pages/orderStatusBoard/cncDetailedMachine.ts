import type {
  CncTelegramBathCard,
  CncTelegramBathItem,
  CncTelegramPacket,
  CncTelegramPacketItem,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import type { CutResultDto } from '../../api/types/cutApi.types';

export const CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM = 1;

export type CncDetailedMachineMatchKind = 'exact' | 'fallback';
export type CncDetailedMachinePreviewKind = 'svg' | 'screenshot' | 'unavailable';

export interface CncDetailedMachineSource {
  packet: CncTelegramPacket;
  matchKind: CncDetailedMachineMatchKind;
  previewKind: CncDetailedMachinePreviewKind;
  cutJobId: number | null;
  resultNo: number | null;
  imageUrl: string | null;
  svgPermissionRequired: boolean;
}

export interface CncMachineResultSheet {
  key: string;
  cutJobId: number;
  resultNo: number;
  cutGroupId: number;
  sheetIndex: number;
  sheetNumber: number;
}

interface BuildSourcesParams {
  columns: CncTelegramTodayColumn[];
  bath: CncTelegramBathCard;
  selectedDetailId: number;
  canViewCut: boolean;
}

export function buildCncDetailedMachineSources({
  columns,
  bath,
  selectedDetailId,
  canViewCut,
}: BuildSourcesParams): CncDetailedMachineSource[] {
  const selectedBathItem = bath.items.find((item) => item.detailId === selectedDetailId);
  if (!selectedBathItem) return [];

  const sources: CncDetailedMachineSource[] = [];
  const seenPackets = new Set<string>();

  for (const column of columns) {
    for (const packet of column.packets) {
      if (seenPackets.has(packet.packetId)) continue;

      const hasExactMatch = packet.items.some((item) => isExactMatch(item, selectedBathItem));
      const fallbackMatches = hasExactMatch
        ? []
        : packet.items.filter((item) => isFallbackMatch(item, selectedBathItem));

      if (!hasExactMatch && fallbackMatches.length !== 1) continue;

      seenPackets.add(packet.packetId);
      sources.push(toSource(packet, hasExactMatch ? 'exact' : 'fallback', canViewCut));
    }
  }

  return sources;
}

export function selectCncMachineResultSheets(
  result: CutResultDto,
  selectedDetailId: number,
): CncMachineResultSheet[] {
  const targetItemId = `det-${selectedDetailId}`;
  const sheets: CncMachineResultSheet[] = [];

  for (const group of result.job.groups) {
    for (const sheet of group.sheets) {
      const containsDetail = sheet.placements.pieces.some((piece) => piece.item_id === targetItemId);
      if (!containsDetail) continue;

      sheets.push({
        key: `${result.cutJobId}:${result.resultNo}:${group.cutGroupId}:${sheet.sheetIndex}`,
        cutJobId: result.cutJobId,
        resultNo: result.resultNo,
        cutGroupId: group.cutGroupId,
        sheetIndex: sheet.sheetIndex,
        sheetNumber: sheet.sheetIndex + 1,
      });
    }
  }

  return sheets;
}

function isExactMatch(item: CncTelegramPacketItem, bathItem: CncTelegramBathItem): boolean {
  return item.matchStatus === 'matched'
    && item.matchOrderId === bathItem.orderId
    && item.matchDetailId === bathItem.detailId;
}

function isFallbackMatch(item: CncTelegramPacketItem, bathItem: CncTelegramBathItem): boolean {
  if (item.matchStatus !== 'unmatched' || item.matchOrderId !== null || item.matchDetailId !== null) {
    return false;
  }
  if (item.detailNumber === null || item.detailNumber !== bathItem.detailNumber) return false;
  if (!belongsToBathOrder(item, bathItem)) return false;

  const itemDimensions = normalizedDimensions(item.widthMm, item.heightMm);
  const bathDimensions = normalizedDimensions(bathItem.widthMm, bathItem.heightMm);
  if (!itemDimensions || !bathDimensions) return false;

  return Math.abs(itemDimensions[0] - bathDimensions[0]) <= CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM
    && Math.abs(itemDimensions[1] - bathDimensions[1]) <= CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM;
}

function belongsToBathOrder(item: CncTelegramPacketItem, bathItem: CncTelegramBathItem): boolean {
  if (item.orderId !== null) return item.orderId === bathItem.orderId;
  return item.orderName.trim().toLocaleLowerCase('ru-RU')
    === bathItem.orderName.trim().toLocaleLowerCase('ru-RU');
}

function normalizedDimensions(
  widthMm: number | null,
  heightMm: number | null,
): readonly [number, number] | null {
  if (widthMm === null || heightMm === null || widthMm <= 0 || heightMm <= 0) return null;
  return widthMm <= heightMm ? [widthMm, heightMm] : [heightMm, widthMm];
}

function toSource(
  packet: CncTelegramPacket,
  matchKind: CncDetailedMachineMatchKind,
  canViewCut: boolean,
): CncDetailedMachineSource {
  const hasImportedSvg = packet.svgCutImportStatus === 'imported'
    && isPositiveInteger(packet.svgCutJobId)
    && isPositiveInteger(packet.svgCutResultId)
    && isPositiveInteger(packet.svgCutResultNo);
  const canUseImportedSvg = canViewCut && hasImportedSvg;
  const imageUrl = packet.sheetImageUrl?.trim() || null;

  return {
    packet,
    matchKind,
    previewKind: canUseImportedSvg ? 'svg' : imageUrl ? 'screenshot' : 'unavailable',
    cutJobId: canUseImportedSvg ? packet.svgCutJobId! : null,
    resultNo: canUseImportedSvg ? packet.svgCutResultNo! : null,
    imageUrl,
    svgPermissionRequired: hasImportedSvg && !canViewCut,
  };
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}
