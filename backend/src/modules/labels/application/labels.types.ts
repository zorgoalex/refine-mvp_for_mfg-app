import type { CurrentUser } from '../../../permissions/current-user';
import type { LabelTextFields } from './scan/label-text-extraction';
import type { OcrTemplateRule } from './scan/ocr-template-matcher';

export type LabelElementKind = 'text' | 'line' | 'rect' | 'qr';
export type LabelExportFormat = 'bmp' | 'png' | 'emf';

export interface LabelTemplateElementDto {
  labelTemplateElementId: number;
  elementKey: string;
  kind: LabelElementKind;
  sourceField: string | null;
  staticText: string | null;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg: number;
  zIndex: number;
  style: Record<string, unknown>;
  condition: Record<string, unknown>;
}

export interface LabelTemplateDto {
  labelTemplateId: number;
  name: string;
  description: string | null;
  version: number;
  isActive: boolean;
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  defaultExportFormats: LabelExportFormat[];
  customFieldSchema: Record<string, unknown>;
  elements: LabelTemplateElementDto[];
}

export interface LabelTemplateElementInput {
  elementKey: string;
  kind: LabelElementKind;
  sourceField?: string | null;
  staticText?: string | null;
  xMm: number;
  yMm: number;
  widthMm: number;
  heightMm: number;
  rotationDeg?: number;
  zIndex?: number;
  style?: Record<string, unknown>;
  condition?: Record<string, unknown>;
}

export interface LabelTemplateInput {
  name: string;
  description?: string | null;
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  defaultExportFormats: LabelExportFormat[];
  customFieldSchema: Record<string, unknown>;
  elements: LabelTemplateElementInput[];
  idempotencyKey: string;
}

export interface OrderLabelDataDetailDto {
  detailId: number;
  orderId: number;
  detailNumber: string | null;
  detailName: string | null;
  height: number | null;
  width: number | null;
  quantity: number;
  materialName: string | null;
  note: string | null;
  basisProject: string | null;
  basisData: string | null;
  detailFields: Record<string, unknown>;
  orderFields: Record<string, unknown>;
  bazisFields: Record<string, unknown>;
  customFields: Record<string, unknown>;
  customFieldSchemaSnapshot: Record<string, unknown>;
  version: number | null;
  staleCustomFieldIds: string[];
}

export interface OrderLabelDataDto {
  orderId: number;
  templateId: number;
  templateVersion: number;
  customFieldSchema: Record<string, unknown>;
  details: OrderLabelDataDetailDto[];
}

export interface OrderLabelDataRowInput {
  detailId: number;
  version?: number | null;
  bazisFields?: Record<string, unknown>;
  customFields?: Record<string, unknown>;
  clearStaleFieldIds?: string[];
}

export interface UpdateOrderLabelDataInput {
  templateId: number;
  rows: OrderLabelDataRowInput[];
  idempotencyKey: string;
}

export interface LabelDetailFilterInput {
  detailIds?: number[];
}

export interface PreviewOrderLabelsInput {
  templateId: number;
  templateVersion: number;
  detailFilters?: LabelDetailFilterInput;
  useBasisFields?: boolean;
}

export interface PreviewDetailLabelsInput {
  templateId: number;
  templateVersion: number;
  /** May contain repeated ids; multiplicity represents physical detail instances. */
  detailIds: number[];
  useBasisFields?: boolean;
}

export interface GenerateOrderLabelsInput extends PreviewOrderLabelsInput {
  previewToken: string;
  exportFormats: LabelExportFormat[];
  idempotencyKey: string;
}

export interface GenerateDetailLabelsInput extends PreviewDetailLabelsInput {
  previewToken: string;
  exportFormats: LabelExportFormat[];
  idempotencyKey: string;
}

export interface OrderLabelsPreviewDto {
  orderId: number;
  templateId: number;
  templateVersion: number;
  labelCount: number;
  rows: unknown[];
  svgPages: string[];
  previewToken: string;
}

export interface DetailLabelsPreviewDto {
  generationScope: 'details';
  templateId: number;
  templateVersion: number;
  labelCount: number;
  rows: unknown[];
  svgPages: string[];
  previewToken: string;
}

export interface OrderLabelGenerationDto {
  generationId: number;
  orderId: number | null;
  templateId: number;
  templateVersion: number;
  labelCount: number;
  generatedAt: string;
}

export interface LatestOrderLabelsPreviewDto extends OrderLabelGenerationDto {
  orderId: number;
  svgPages: string[];
}

export interface LabelsContext {
  currentUser: CurrentUser;
  requestId: string;
}

export interface ListLabelTemplatesQuery extends LabelsContext {
  includeInactive?: boolean;
}

export interface GetLabelTemplateQuery extends LabelsContext {
  id: number;
}

export interface CreateLabelTemplateCommand extends LabelsContext {
  input: LabelTemplateInput;
}

export interface UpdateLabelTemplateCommand extends LabelsContext {
  id: number;
  expectedVersion: number;
  input: LabelTemplateInput;
}

export interface DeleteLabelTemplateCommand extends LabelsContext {
  id: number;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface LabelQrTemplateDto {
  labelQrTemplateId: number;
  name: string;
  contentTemplate: string;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  defaultSizeMm: number;
  isActive: boolean;
  version: number;
}

export interface LabelQrTemplateInput {
  name: string;
  contentTemplate: string;
  errorCorrection: 'L' | 'M' | 'Q' | 'H';
  defaultSizeMm: number;
  idempotencyKey: string;
}

export interface ListLabelQrTemplatesQuery extends LabelsContext {
  includeInactive?: boolean;
}

export interface CreateLabelQrTemplateCommand extends LabelsContext {
  input: LabelQrTemplateInput;
}

export interface UpdateLabelQrTemplateCommand extends LabelsContext {
  id: number;
  expectedVersion: number;
  input: LabelQrTemplateInput;
}

export interface DeleteLabelQrTemplateCommand extends LabelsContext {
  id: number;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface LabelOcrTemplateDto {
  labelOcrTemplateId: number;
  name: string;
  rules: OcrTemplateRule[];
  sampleLines: string[];
  isActive: boolean;
  version: number;
}

export interface LabelOcrTemplateInput {
  name: string;
  rules: OcrTemplateRule[];
  sampleLines: string[];
  isActive: boolean;
  idempotencyKey: string;
}

export interface ListLabelOcrTemplatesQuery extends LabelsContext {
  includeInactive?: boolean;
}

export interface CreateLabelOcrTemplateCommand extends LabelsContext {
  input: LabelOcrTemplateInput;
}

export interface UpdateLabelOcrTemplateCommand extends LabelsContext {
  id: number;
  expectedVersion: number;
  input: LabelOcrTemplateInput;
}

export interface DeleteLabelOcrTemplateCommand extends LabelsContext {
  id: number;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface GetOrderLabelDataQuery extends LabelsContext {
  orderId: number;
  templateId: number;
}

export interface UpdateOrderLabelDataCommand extends LabelsContext {
  orderId: number;
  input: UpdateOrderLabelDataInput;
}

export interface PreviewOrderLabelsCommand extends LabelsContext {
  orderId: number;
  input: PreviewOrderLabelsInput;
}

export interface GenerateOrderLabelsCommand extends LabelsContext {
  orderId: number;
  input: GenerateOrderLabelsInput;
}

export interface PreviewDetailLabelsCommand extends LabelsContext {
  input: PreviewDetailLabelsInput;
}

export interface GenerateDetailLabelsCommand extends LabelsContext {
  input: GenerateDetailLabelsInput;
}

export interface ExportOrderLabelsQuery extends LabelsContext {
  orderId: number;
  generationId?: number;
}

export interface ExportDetailLabelsQuery extends LabelsContext {
  generationId: number;
}

export interface ScanSearchInput {
  detailId?: number;
  orderId?: number;
  orderName?: string;
  detailNumber?: number;
  /** Распарсенные bazis.*-поля QR для верификации/поиска по снапшоту печати.
   *  Ключи — в формате хранения order_label_detail_data.bazis_fields
   *  (формат СВЕРИТЬ с write-path: pg-labels-repository upsert ~:595 и
   *  mapOrderLabelDetail; нормализация ключей — на стороне сервиса). */
  bazisFields?: Record<string, string>;
}

export interface ScanCandidateRow {
  detailId: number;
  orderId: number;
  orderName: string;
  detailNumber: number | null;
  width: number | null;
  height: number | null;
  quantity: number | null;
  materialName: string | null;
  productionStatusName: string | null;
  matchedFields: string[];
}

export interface ScanResolveCommand extends LabelsContext {
  payload: string;
  source: 'qr' | 'manual';
}

export interface ScanResolveCandidate extends ScanCandidateRow {
  score: number;
  matchedBy: string;
}

export interface ScanResolveResult {
  candidates: ScanResolveCandidate[];
  parsed: Record<string, string> | null;
  templatesTried: number;
}

/** scanResolveFields (T4): OCR-extracted text fields -> ScanSearchInput -> ranked candidates. */
export interface ScanResolveFieldsCommand extends LabelsContext {
  fields: LabelTextFields;
}

/** scanResolveImage (T4): raw uploaded image bytes -> OcrPort.recognize -> extractLabelFields -> scanResolveFields. */
export interface ScanResolveImageCommand extends LabelsContext {
  image: Buffer;
  contentType: string;
}

export interface ScanResolveImageResult extends ScanResolveResult {
  ocr: { lineCount: number; durationMs: number };
}

export interface LabelsPermissionDeniedInput {
  currentUser: CurrentUser;
  requiredPermissions: string[];
  requestId: string;
  targetId?: number;
  targetEntityType?: 'label_template' | 'order' | 'label_qr_template' | 'label_ocr_template';
}

/** One recognized text line from ocr-service (recognition box intentionally dropped — backend has no use for it). */
export interface OcrLine {
  text: string;
  score: number;
}

/**
 * Port to the standalone ocr-service (T1: POST /ocr, raw image bytes → {lines,durationMs}).
 * Implementations: HttpOcrClient (adapters/http-ocr-client.ts) when OCR_SERVICE_BASE_URL is
 * configured, UnavailableOcrClient otherwise. Not yet wired into LabelsService (see T4).
 */
export interface OcrPort {
  recognize(image: Buffer, contentType: string): Promise<{ lines: OcrLine[]; durationMs: number }>;
}

export interface LabelsPort {
  listTemplates(query: ListLabelTemplatesQuery): Promise<LabelTemplateDto[]>;
  getTemplateById(query: GetLabelTemplateQuery): Promise<LabelTemplateDto>;
  createTemplate(command: CreateLabelTemplateCommand): Promise<LabelTemplateDto>;
  updateTemplate(command: UpdateLabelTemplateCommand): Promise<LabelTemplateDto>;
  deleteTemplate(command: DeleteLabelTemplateCommand): Promise<void>;
  getOrderLabelData(query: GetOrderLabelDataQuery): Promise<OrderLabelDataDto>;
  updateOrderLabelData(command: UpdateOrderLabelDataCommand): Promise<OrderLabelDataDto>;
  previewOrderLabels(command: PreviewOrderLabelsCommand): Promise<OrderLabelsPreviewDto>;
  generateOrderLabels(command: GenerateOrderLabelsCommand): Promise<OrderLabelGenerationDto>;
  previewDetailLabels(command: PreviewDetailLabelsCommand): Promise<DetailLabelsPreviewDto>;
  generateDetailLabels(command: GenerateDetailLabelsCommand): Promise<OrderLabelGenerationDto>;
  getLatestOrderLabelsPreview(query: ExportOrderLabelsQuery): Promise<LatestOrderLabelsPreviewDto>;
  exportOrderLabels(query: ExportOrderLabelsQuery): Promise<{ filename: string; contentType: string; body: Buffer }>;
  exportDetailLabels(query: ExportDetailLabelsQuery): Promise<{ filename: string; contentType: string; body: Buffer }>;
  recordPermissionDenied(input: LabelsPermissionDeniedInput): Promise<void>;
  listQrTemplates(query: ListLabelQrTemplatesQuery): Promise<LabelQrTemplateDto[]>;
  createQrTemplate(command: CreateLabelQrTemplateCommand): Promise<LabelQrTemplateDto>;
  updateQrTemplate(command: UpdateLabelQrTemplateCommand): Promise<LabelQrTemplateDto>;
  deleteQrTemplate(command: DeleteLabelQrTemplateCommand): Promise<void>;
  listActiveQrTemplateStrings(): Promise<string[]>;
  findScanCandidates(input: ScanSearchInput): Promise<ScanCandidateRow[]>;
}
