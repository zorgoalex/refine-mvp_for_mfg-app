import type { BazisCutDetailFields } from '../../bazis-cut/dto/bazis-cut.dto';

export const EXPORT_TEMPLATE_SCHEMA_VERSION = 1 as const;
export const EXPORT_TEMPLATE_FORMATS = ['xls_biff8'] as const;
export const EXPORT_TEMPLATE_TARGETS = ['bazis_cut_set', 'bazis_project_card'] as const;
export const EXPORT_TEMPLATE_SOURCES = ['bazis_cut_set_detail', 'bazis_project_panel'] as const;

export type ExportTemplateFormat = (typeof EXPORT_TEMPLATE_FORMATS)[number];
export type ExportTemplateTarget = (typeof EXPORT_TEMPLATE_TARGETS)[number];
export type ExportTemplateSource = (typeof EXPORT_TEMPLATE_SOURCES)[number];
export type ExportScalar = string | number | boolean | null;

export type ExportConditionOperator =
  | 'exists'
  | 'not_empty'
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface ExportCondition {
  left: ExportExpression;
  op: ExportConditionOperator;
  right?: ExportExpression;
}

export type ExportExpression =
  | { type: 'field'; field: string }
  | { type: 'column_ref'; columnKey: string }
  | { type: 'constant'; value: ExportScalar }
  | { type: 'empty' }
  | { type: 'concat'; parts: ExportExpression[] }
  | { type: 'if_else'; when: ExportCondition; then: ExportExpression; else: ExportExpression }
  | { type: 'string_fn'; fn: 'trim' | 'upper' | 'lower'; input: ExportExpression }
  | { type: 'number_fn'; fn: 'round' | 'floor' | 'ceil' | 'abs'; input: ExportExpression; digits?: number }
  | { type: 'math'; fn: 'add' | 'subtract' | 'multiply' | 'divide'; parts: ExportExpression[] };

export interface ExportTemplateColumn {
  columnKey: string;
  header: string;
  expression: ExportExpression;
}

export interface ExportTemplateSnapshot {
  exportTemplateId: number;
  code: string | null;
  name: string;
  description: string | null;
  targetScreen: ExportTemplateTarget;
  sourceType: ExportTemplateSource;
  format: ExportTemplateFormat;
  sheetName: string;
  schemaVersion: typeof EXPORT_TEMPLATE_SCHEMA_VERSION;
  templateHash: string;
  columns: ExportTemplateColumn[];
  isActive: boolean;
  isDefault: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
  updatedBy: number | null;
}

export interface ExportTemplateSummary {
  exportTemplateId: number;
  code: string | null;
  name: string;
  targetScreen: ExportTemplateTarget;
  sourceType: ExportTemplateSource;
  format: ExportTemplateFormat;
  isDefault: boolean;
  version: number;
}

export type BazisExportDetail = BazisCutDetailFields & {
  sourceBazisProjectName?: string;
  sourceBazisOrderNo?: string;
  sourceBazisProductName?: string;
  sourceBathCutNumber?: string;
  sourceOrderName?: string;
  sourceOrderFullNumber?: string;
  sourceProjectCode?: string;
  sourceOrderDetailId?: number | null;
  sourceOrderId?: number | null;
  sourceProjectId?: number | null;
  sourceBazisProjectId?: number | null;
  sourceBazisRevisionId?: number | null;
  sourceBazisNodeId?: number | null;
  /** Direct Basis-project export preserves its project-derived Excel Order. */
  xlsOrder?: string;
};

export interface ExportEvaluationContext {
  rowNumber: number;
  exportedAt: Date;
  templateName: string;
}

export interface ExportFieldDefinition {
  key: string;
  label: string;
  group: 'Поля детали' | 'Источник' | 'Совместимость' | 'Динамические';
  valueType: 'string' | 'number' | 'boolean' | 'date-time';
}

export interface ExportTemplateCatalog {
  schemaVersion: typeof EXPORT_TEMPLATE_SCHEMA_VERSION;
  targets: Array<{ code: ExportTemplateTarget; label: string; sourceType: ExportTemplateSource }>;
  formats: Array<{ code: ExportTemplateFormat; label: string }>;
  fields: ExportFieldDefinition[];
  operators: ExportConditionOperator[];
  functions: {
    string: Array<'trim' | 'upper' | 'lower'>;
    number: Array<'round' | 'floor' | 'ceil' | 'abs'>;
    math: Array<'add' | 'subtract' | 'multiply' | 'divide'>;
  };
  limits: {
    maxColumns: number;
    maxExpressionDepth: number;
    maxExpressionNodes: number;
    maxCells: number;
    maxEvaluatedNodes: number;
  };
}
