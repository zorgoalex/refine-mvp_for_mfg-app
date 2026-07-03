import type { CurrentUser } from '../../../permissions/current-user';

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

export interface LabelsPermissionDeniedInput {
  currentUser: CurrentUser;
  requiredPermissions: string[];
  requestId: string;
  targetId?: number;
  targetEntityType?: 'label_template' | 'order' | 'label_qr_template';
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
}
