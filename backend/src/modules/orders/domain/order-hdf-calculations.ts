import { createHash } from 'node:crypto';

export const HDF_CLEARANCE_PER_SIDE_MM = 0.5;
export const HDF_TOTAL_CLEARANCE_MM = HDF_CLEARANCE_PER_SIDE_MM * 2;

export type OrderHdfStatus =
  | 'ok'
  | 'too_narrow'
  | 'invalid_dimensions'
  | 'config_missing'
  | 'source_changed'
  | 'disabled';

export interface OrderHdfSourceDetailInput {
  detailId: number;
  detailNumber: number | null;
  detailName: string | null;
  heightMm: number | null;
  widthMm: number | null;
  quantity: number | null;
  sheetMaterialTypeId: number | null;
  sheetMaterialName: string | null;
  millingTypeId: number | null;
  millingTypeName: string | null;
  hdfParameterOverrideMm?: number | null;
  productionStatusId: number | null;
}

export interface OrderHdfMillingInput {
  hdfEnabled: boolean;
  hdfEdgeMm: number | null;
}

export interface OrderHdfConfigInput {
  thresholdMm: number | null;
  hdfSheetMaterialTypeId: number | null;
  hdfSheetMaterialName: string | null;
  configRevision: number;
}

export interface CalculatedOrderHdfDetail {
  status: OrderHdfStatus;
  configErrors: string[];
  edgeMm: number | null;
  thresholdMm: number | null;
  hdfHeightMm: number | null;
  hdfWidthMm: number | null;
  quantity: number | null;
  areaM2: number;
  sourceSnapshotHash: string;
  sourceSnapshotJson: Record<string, unknown>;
  configRevision: number;
}

export function calculateOrderHdfDetail(
  source: OrderHdfSourceDetailInput,
  milling: OrderHdfMillingInput,
  config: OrderHdfConfigInput,
): CalculatedOrderHdfDetail {
  const configErrors = validateConfig(config);
  const edgeMm = positiveNumber(milling.hdfEdgeMm);
  const thresholdMm = positiveNumber(config.thresholdMm);
  const heightMm = positiveNumber(source.heightMm);
  const widthMm = positiveNumber(source.widthMm);
  const quantity = positiveNumber(source.quantity);
  const snapshot = buildSourceSnapshot(source, milling, config);
  const sourceSnapshotHash = stableHash(snapshot);

  if (!milling.hdfEnabled) {
    return result('disabled', configErrors, edgeMm, thresholdMm, null, null, quantity, snapshot, sourceSnapshotHash, config.configRevision);
  }

  if (configErrors.length > 0) {
    return result('config_missing', configErrors, edgeMm, thresholdMm, null, null, quantity, snapshot, sourceSnapshotHash, config.configRevision);
  }

  if (edgeMm === null || heightMm === null || widthMm === null || quantity === null) {
    return result('invalid_dimensions', configErrors, edgeMm, thresholdMm, null, null, quantity, snapshot, sourceSnapshotHash, config.configRevision);
  }

  const hdfHeightMm = roundMm(heightMm - edgeMm * 2 - HDF_TOTAL_CLEARANCE_MM);
  const hdfWidthMm = roundMm(widthMm - edgeMm * 2 - HDF_TOTAL_CLEARANCE_MM);
  if (hdfHeightMm <= 0 || hdfWidthMm <= 0) {
    return result('invalid_dimensions', configErrors, edgeMm, thresholdMm, hdfHeightMm, hdfWidthMm, quantity, snapshot, sourceSnapshotHash, config.configRevision);
  }

  if (thresholdMm !== null && (hdfHeightMm < thresholdMm || hdfWidthMm < thresholdMm)) {
    return result('too_narrow', configErrors, edgeMm, thresholdMm, hdfHeightMm, hdfWidthMm, quantity, snapshot, sourceSnapshotHash, config.configRevision);
  }

  return result('ok', configErrors, edgeMm, thresholdMm, hdfHeightMm, hdfWidthMm, quantity, snapshot, sourceSnapshotHash, config.configRevision);
}

export function calculateHdfAreaM2(heightMm: number | null, widthMm: number | null, quantity: number | null): number {
  const height = positiveNumber(heightMm);
  const width = positiveNumber(widthMm);
  const qty = positiveNumber(quantity);
  if (height === null || width === null || qty === null) return 0;
  return roundAreaM2((height * width * qty) / 1_000_000);
}

export function roundAreaM2(value: number): number {
  const hundredths = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(hundredths));
  return Math.round(hundredths + tolerance) / 100;
}

function result(
  status: OrderHdfStatus,
  configErrors: string[],
  edgeMm: number | null,
  thresholdMm: number | null,
  hdfHeightMm: number | null,
  hdfWidthMm: number | null,
  quantity: number | null,
  sourceSnapshotJson: Record<string, unknown>,
  sourceSnapshotHash: string,
  configRevision: number,
): CalculatedOrderHdfDetail {
  return {
    status,
    configErrors,
    edgeMm,
    thresholdMm,
    hdfHeightMm,
    hdfWidthMm,
    quantity,
    areaM2: status === 'ok' ? calculateHdfAreaM2(hdfHeightMm, hdfWidthMm, quantity) : 0,
    sourceSnapshotHash,
    sourceSnapshotJson,
    configRevision,
  };
}

function validateConfig(config: OrderHdfConfigInput): string[] {
  const errors: string[] = [];
  if (positiveNumber(config.thresholdMm) === null) errors.push('missing_threshold');
  if (!positiveInteger(config.hdfSheetMaterialTypeId)) errors.push('missing_hdf_sheet_material');
  if (!Number.isSafeInteger(config.configRevision) || config.configRevision <= 0) errors.push('missing_config_revision');
  return errors;
}

function buildSourceSnapshot(
  source: OrderHdfSourceDetailInput,
  milling: OrderHdfMillingInput,
  config: OrderHdfConfigInput,
): Record<string, unknown> {
  return {
    sourceDetailId: source.detailId,
    sourceDetailNumber: source.detailNumber,
    sourceDetailName: source.detailName,
    sourceHeightMm: source.heightMm,
    sourceWidthMm: source.widthMm,
    sourceQuantity: source.quantity,
    sourceSheetMaterialTypeId: source.sheetMaterialTypeId,
    sourceSheetMaterialName: source.sheetMaterialName,
    millingTypeId: source.millingTypeId,
    millingTypeName: source.millingTypeName,
    hdfParameterOverrideMm: source.hdfParameterOverrideMm ?? null,
    hdfEnabled: milling.hdfEnabled,
    edgeMm: milling.hdfEdgeMm,
    clearancePerSideMm: HDF_CLEARANCE_PER_SIDE_MM,
    totalClearanceMm: HDF_TOTAL_CLEARANCE_MM,
    thresholdMm: config.thresholdMm,
    hdfSheetMaterialTypeId: config.hdfSheetMaterialTypeId,
    hdfSheetMaterialName: config.hdfSheetMaterialName,
    configRevision: config.configRevision,
  };
}

function stableHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(sortObject(value))).digest('hex');
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortObject((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function positiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function positiveInteger(value: unknown): boolean {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

function roundMm(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
