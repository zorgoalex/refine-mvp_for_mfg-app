export type LabelExportFormat = 'bmp' | 'png' | 'emf';
export type LabelElementKind = 'text' | 'line' | 'rect' | 'qr';

export interface LabelFieldCatalogItem {
  id: string;
  source: 'bazis' | 'dynamic' | 'detail' | 'order';
  sourceColumn: string | null;
  label: string;
  type: 'string' | 'number' | 'boolean' | 'date';
  category: string;
}

export interface LabelTemplateElement {
  labelTemplateElementId?: number;
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

export interface LabelTemplate {
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
  elements: LabelTemplateElement[];
}

export interface LabelTemplateInput {
  name: string;
  description?: string | null;
  canvasWidthMm: number;
  canvasHeightMm: number;
  dpi: number;
  defaultExportFormats: LabelExportFormat[];
  customFieldSchema: Record<string, unknown>;
  elements: LabelTemplateElement[];
  idempotencyKey: string;
}

export interface UpdateLabelTemplateInput extends LabelTemplateInput {
  version: number;
}

export interface OrderLabelData {
  orderId: number;
  templateId: number;
  templateVersion: number;
  customFieldSchema: Record<string, unknown>;
  details: Array<{
    detailId: number;
    orderId: number;
    detailNumber: string | null;
    detailName: string | null;
    quantity: number;
    materialName: string | null;
    note: string | null;
    basisProject: string | null;
    basisData: string | null;
    detailFields: Record<string, unknown>;
    orderFields: Record<string, unknown>;
    bazisFields: Record<string, unknown>;
    customFields: Record<string, unknown>;
    version: number | null;
    staleCustomFieldIds: string[];
  }>;
}

export interface UpdateOrderLabelDataInput {
  templateId: number;
  rows: Array<{
    detailId: number;
    version?: number | null;
    bazisFields?: Record<string, unknown>;
    customFields?: Record<string, unknown>;
    clearStaleFieldIds?: string[];
  }>;
  idempotencyKey: string;
}

export interface PreviewOrderLabelsInput {
  templateId: number;
  templateVersion: number;
  detailFilters?: { detailIds?: number[] };
  useBasisFields?: boolean;
}

export interface GenerateOrderLabelsInput extends PreviewOrderLabelsInput {
  previewToken: string;
  exportFormats: LabelExportFormat[];
  idempotencyKey: string;
}

export interface PreviewDetailLabelsInput {
  templateId: number;
  templateVersion: number;
  /** May include repeated ids; repeated ids represent physical instances on a cut sheet. */
  detailIds: number[];
  useBasisFields?: boolean;
}

export interface GenerateDetailLabelsInput extends PreviewDetailLabelsInput {
  previewToken: string;
  exportFormats: LabelExportFormat[];
  idempotencyKey: string;
}

export interface OrderLabelsPreview {
  orderId: number;
  templateId: number;
  templateVersion: number;
  labelCount: number;
  rows: unknown[];
  svgPages: string[];
  previewToken: string;
}

export interface DetailLabelsPreview {
  generationScope: 'details';
  templateId: number;
  templateVersion: number;
  labelCount: number;
  rows: unknown[];
  svgPages: string[];
  previewToken: string;
}

export interface OrderLabelGeneration {
  generationId: number;
  orderId: number | null;
  templateId: number;
  templateVersion: number;
  labelCount: number;
  generatedAt: string;
}

export interface LatestOrderLabelsPreview extends OrderLabelGeneration {
  svgPages: string[];
}

export interface LabelQrTemplate {
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

export type UpdateLabelQrTemplateInput = LabelQrTemplateInput & { version: number };

export interface ScanCandidate {
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
  matchedBy: string;
  score: number;
}

export interface ScanResolveResult {
  candidates: ScanCandidate[];
  parsed: Record<string, string> | null;
  templatesTried: number;
  /** Present only for scanResolveImage (OCR fallback) responses. */
  ocr?: { lineCount: number; durationMs: number };
}

export type OcrFieldCode =
  | 'order_number'
  | 'order_name'
  | 'detail_number'
  | 'dimensions'
  | 'material'
  | 'quantity'
  | 'date'
  | 'detail_name'
  | 'ignore';

export interface OcrTemplateRule {
  field: OcrFieldCode;
  sampleText?: string;
  anchor?: string | null;
}

export interface LabelOcrTemplate {
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

export interface UpdateLabelOcrTemplateInput extends LabelOcrTemplateInput {
  version: number;
}

export interface OcrLabelTextFields {
  orderName?: string;
  detailNumber?: number;
  width?: number;
  height?: number;
  date?: string;
  material?: string;
}

export interface OcrPreviewResult {
  lines: { text: string; score: number }[];
  durationMs: number;
}

export interface OcrTestResult {
  lines: { text: string; score: number }[];
  matched: { templateWon: boolean; score: number; fields: OcrLabelTextFields };
  fallbackFields: OcrLabelTextFields;
}
