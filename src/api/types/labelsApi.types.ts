export type LabelExportFormat = 'bmp' | 'png' | 'emf';
export type LabelElementKind = 'text' | 'line' | 'rect';

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

export interface OrderLabelsPreview {
  orderId: number;
  templateId: number;
  templateVersion: number;
  labelCount: number;
  rows: unknown[];
  svgPages: string[];
  previewToken: string;
}

export interface OrderLabelGeneration {
  generationId: number;
  orderId: number;
  templateId: number;
  templateVersion: number;
  labelCount: number;
  generatedAt: string;
}

export interface LatestOrderLabelsPreview extends OrderLabelGeneration {
  svgPages: string[];
}
