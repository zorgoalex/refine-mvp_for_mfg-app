import type {
  CncTelegramBathCard,
  CncTelegramBathItem,
  CncTelegramPacket,
  CncTelegramPacketItem,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import type { CutResultDto } from '../../api/types/cutApi.types';

export const CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM = 3;
const CNC_OTHER_MATERIAL_MARKER_PATTERN = /(?:^|[^a-zа-яё])(?:hdf|хдф|лдсп|ldsp|lдсп|дсп|dsp|двп|dvp|osb|осп|fanera|фанера|plywood|акрил|acrylic|пластик|plastic)(?=$|[^a-zа-яё])/i;
const CNC_MDF_MATERIAL_PATTERN = /(?:^|[^a-zа-яё])(?:mdf|мдф)(?=$|[^a-zа-яё])/i;
const CNC_UNKNOWN_MATERIAL_PATTERN = /^(?:не\s*(?:определ[её]н(?:о)?|распознан(?:о)?)|неизвестн(?:ый|о)?|unknown|[-—])$/i;

export type CncDetailedMachineMatchKind = 'exact' | 'fallback' | 'whole_order' | 'order';
export type CncDetailedMachinePreviewKind = 'svg' | 'screenshot' | 'unavailable';

export interface CncDetailedMachineSource {
  packet: CncTelegramPacket;
  matchKind: CncDetailedMachineMatchKind;
  previewKind: CncDetailedMachinePreviewKind;
  cutJobId: number | null;
  resultNo: number | null;
  imageUrl: string | null;
  svgPermissionRequired: boolean;
  otherMaterial: boolean;
  autoExpand: boolean;
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
  selectedDetailId: number | null;
  canViewCut: boolean;
}

export function buildCncDetailedMachineSources({
  columns,
  bath,
  selectedDetailId,
  canViewCut,
}: BuildSourcesParams): CncDetailedMachineSource[] {
  const selectedBathItems = selectedDetailId === null
    ? bath.items
    : bath.items.filter((item) => item.detailId === selectedDetailId);
  if (selectedBathItems.length === 0) return [];

  const sources: CncDetailedMachineSource[] = [];
  const seenPackets = new Set<string>();

  for (const column of columns) {
    for (const packet of column.packets) {
      if (seenPackets.has(packet.packetId)) continue;

      const otherMaterial = cncPacketHasOtherMaterialMarker(packet);
      const matchKind = cncDetailedMachineMatchKind(packet, selectedBathItems, otherMaterial);
      if (matchKind === null) continue;

      seenPackets.add(packet.packetId);
      sources.push(toSource(packet, matchKind, canViewCut, otherMaterial));
    }
  }

  return sources;
}

export function cncBathDetailHasMachineFile(
  columns: CncTelegramTodayColumn[],
  bath: CncTelegramBathCard,
  detailId: number,
): boolean {
  return buildCncDetailedMachineSources({
    columns,
    bath,
    selectedDetailId: detailId,
    canViewCut: false,
  }).some((source) => source.matchKind !== 'order');
}

export function selectCncMachineResultSheets(
  result: CutResultDto,
  selectedDetailId: number | null,
): CncMachineResultSheet[] {
  const targetItemId = selectedDetailId === null ? null : `det-${selectedDetailId}`;
  const hasOrderDetailPieces = result.job.groups.some((group) =>
    group.sheets.some((sheet) =>
      sheet.placements.pieces.some((piece) => /^det-\d+$/.test(piece.item_id)),
    ),
  );
  const sheets: CncMachineResultSheet[] = [];

  for (const group of result.job.groups) {
    for (const sheet of group.sheets) {
      const containsDetail = targetItemId === null
        || !hasOrderDetailPieces
        || sheet.placements.pieces.some((piece) => piece.item_id === targetItemId);
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

export function cncPacketHasOtherMaterialMarker(packet: CncTelegramPacket): boolean {
  const metadata = [
    packet.materialName,
    packet.programName ?? '',
    packet.externalPacketKey,
    ...packet.comments,
  ];
  if (metadata.some((text) => CNC_OTHER_MATERIAL_MARKER_PATTERN.test(text))) return true;

  const materialName = packet.materialName.trim();
  if (!materialName || CNC_UNKNOWN_MATERIAL_PATTERN.test(materialName)) return false;
  return !CNC_MDF_MATERIAL_PATTERN.test(materialName);
}

export function cncMaterialNameIsMdf(materialName: string | null | undefined): boolean {
  const normalized = materialName?.trim() ?? '';
  if (!normalized || CNC_UNKNOWN_MATERIAL_PATTERN.test(normalized)) return false;
  if (CNC_OTHER_MATERIAL_MARKER_PATTERN.test(normalized)) return false;
  return CNC_MDF_MATERIAL_PATTERN.test(normalized);
}

export function cncPacketCountsForMdfReadiness(packet: CncTelegramPacket): boolean {
  const metadata = [
    packet.materialName,
    packet.programName ?? '',
    packet.externalPacketKey,
    ...packet.comments,
  ];
  if (metadata.some((text) => CNC_OTHER_MATERIAL_MARKER_PATTERN.test(text))) return false;
  return cncMaterialNameIsMdf(packet.materialName);
}

function isExactMatch(item: CncTelegramPacketItem, bathItem: CncTelegramBathItem): boolean {
  return item.matchOrderId === bathItem.orderId
    && item.matchDetailId === bathItem.detailId;
}

function isFallbackMatch(item: CncTelegramPacketItem, bathItem: CncTelegramBathItem): boolean {
  if (item.matchOrderId !== null || item.matchDetailId !== null) {
    return false;
  }
  if (item.detailNumber === null || item.detailNumber !== bathItem.detailNumber) return false;
  if (!belongsToBathOrder(item, bathItem)) return false;

  const itemDimensions = normalizedDimensions(item.widthMm, item.heightMm);
  const bathDimensions = normalizedDimensions(bathItem.widthMm, bathItem.heightMm);
  if (!itemDimensions || !bathDimensions) return false;

  const toleranceMm = item.source === 'ocr' ? CNC_MACHINE_DETAIL_SIZE_TOLERANCE_MM : 0;
  return Math.abs(itemDimensions[0] - bathDimensions[0]) <= toleranceMm
    && Math.abs(itemDimensions[1] - bathDimensions[1]) <= toleranceMm;
}

function cncDetailedMachineMatchKind(
  packet: CncTelegramPacket,
  bathItems: readonly CncTelegramBathItem[],
  otherMaterial: boolean,
): CncDetailedMachineMatchKind | null {
  if (packet.items.some((item) => bathItems.some((bathItem) => isExactMatch(item, bathItem)))) {
    return 'exact';
  }
  if (packet.items.some((item) => bathItems.some((bathItem) => isFallbackMatch(item, bathItem)))) {
    return 'fallback';
  }
  if (!otherMaterial && packetCompletesWholeBathOrder(packet, bathItems)) {
    return 'whole_order';
  }
  return otherMaterial && packetSharesBathOrder(packet, bathItems) ? 'order' : null;
}

function packetCompletesWholeBathOrder(
  packet: CncTelegramPacket,
  bathItems: readonly CncTelegramBathItem[],
): boolean {
  if (packet.completionStatus !== 'completed' && !packet.thumbsUp) return false;
  const bathOrderKeys = new Set(
    bathItems.map((item) => item.orderName.trim().toLocaleLowerCase('ru-RU')),
  );
  return packet.comments.some((comment) => {
    if (!comment.toLocaleLowerCase('ru-RU').includes('весь')) return false;
    return Array.from(comment.matchAll(/(^|[^0-9])([0-9]{4,})(?=[^0-9]|$)/g))
      .some((match) => bathOrderKeys.has((match[2] ?? '').toLocaleLowerCase('ru-RU')));
  });
}

function packetSharesBathOrder(
  packet: CncTelegramPacket,
  bathItems: readonly CncTelegramBathItem[],
): boolean {
  const bathOrderKeys = new Set<string>();
  for (const item of bathItems) {
    addCncMachineOrderKeys(bathOrderKeys, item.orderName, item.orderId);
  }

  const packetOrderKeys = new Set<string>();
  for (const item of packet.items) {
    addCncMachineOrderKeys(packetOrderKeys, item.orderName, item.orderId, item.matchOrderId);
  }
  for (const text of [packet.programName, ...packet.comments]) {
    for (const match of (text ?? '').matchAll(/(^|[^0-9])([0-9]{4,})(?=[^0-9]|$)/g)) {
      const orderName = match[2];
      if (orderName) packetOrderKeys.add(cncMachineOrderNameKey(orderName));
    }
  }

  return Array.from(packetOrderKeys).some((key) => bathOrderKeys.has(key));
}

function addCncMachineOrderKeys(
  target: Set<string>,
  orderName: string,
  ...orderIds: Array<number | null | undefined>
): void {
  for (const orderId of orderIds) {
    if (Number.isInteger(orderId) && Number(orderId) > 0) target.add(`id:${orderId}`);
  }
  const normalizedOrderName = orderName.trim();
  if (normalizedOrderName) target.add(cncMachineOrderNameKey(normalizedOrderName));
}

function cncMachineOrderNameKey(orderName: string): string {
  return `name:${orderName.trim().toLocaleLowerCase('ru-RU')}`;
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
  otherMaterial: boolean,
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
    otherMaterial,
    autoExpand: !otherMaterial,
  };
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}
