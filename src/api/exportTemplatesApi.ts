import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';

export type ExportTemplateTarget = 'bazis_cut_set' | 'bazis_project_card';
export type ExportTemplateSource = 'bazis_cut_set_detail' | 'bazis_project_panel';
export type ExportTemplateFormat = 'xls_biff8';
export type ExportScalar = string | number | boolean | null;
export type ExportConditionOperator = 'exists' | 'not_empty' | 'equals' | 'not_equals' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte';

export type ExportExpression =
  | { type: 'field'; field: string }
  | { type: 'constant'; value: ExportScalar }
  | { type: 'empty' }
  | { type: 'concat'; parts: ExportExpression[] }
  | { type: 'if_else'; when: { left: ExportExpression; op: ExportConditionOperator; right?: ExportExpression }; then: ExportExpression; else: ExportExpression }
  | { type: 'string_fn'; fn: 'trim' | 'upper' | 'lower'; input: ExportExpression }
  | { type: 'number_fn'; fn: 'round' | 'floor' | 'ceil' | 'abs'; input: ExportExpression; digits?: number }
  | { type: 'math'; fn: 'add' | 'subtract' | 'multiply' | 'divide'; parts: ExportExpression[] };

export interface ExportTemplateColumn {
  columnKey: string;
  header: string;
  expression: ExportExpression;
}

export interface ExportTemplateDto {
  exportTemplateId: number;
  code: string | null;
  name: string;
  description: string | null;
  targetScreen: ExportTemplateTarget;
  sourceType: ExportTemplateSource;
  format: ExportTemplateFormat;
  sheetName: string;
  schemaVersion: 1;
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

export interface ExportTemplateCatalog {
  schemaVersion: 1;
  targets: Array<{ code: ExportTemplateTarget; label: string; sourceType: ExportTemplateSource }>;
  formats: Array<{ code: ExportTemplateFormat; label: string }>;
  fields: Array<{ key: string; label: string; group: string; valueType: string }>;
  operators: ExportConditionOperator[];
  functions: {
    string: Array<'trim' | 'upper' | 'lower'>;
    number: Array<'round' | 'floor' | 'ceil' | 'abs'>;
    math: Array<'add' | 'subtract' | 'multiply' | 'divide'>;
  };
  limits: Record<string, number>;
}

export type ExportTemplateDraft = Pick<ExportTemplateDto,
  'name' | 'description' | 'targetScreen' | 'sourceType' | 'format' | 'sheetName' | 'schemaVersion' | 'columns' | 'isActive'>;

const ROOT = backendApiPath('/export-templates');
const routes = {
  list: ROOT,
  catalog: `${ROOT}/catalog`,
  available: `${ROOT}/available`,
  preview: `${ROOT}/preview`,
  byId: (id: number) => `${ROOT}/${validId(id)}`,
  setDefault: (id: number) => `${ROOT}/${validId(id)}/set-default`,
};

export const exportTemplatesApi = {
  catalog: () => httpClient.get<ExportTemplateCatalog>(routes.catalog),
  list: (includeInactive = true) => httpClient.get<ExportTemplateDto[]>(withQuery(routes.list, { includeInactive })),
  available: (targetScreen: ExportTemplateTarget, sourceType: ExportTemplateSource) =>
    httpClient.get<ExportTemplateSummary[]>(withQuery(routes.available, { targetScreen, sourceType, format: 'xls_biff8' })),
  create: (draft: ExportTemplateDraft, idempotencyKey: string) =>
    httpClient.post<ExportTemplateDto>(routes.list, { ...draft, idempotencyKey }),
  update: (id: number, draft: ExportTemplateDraft, expectedVersion: number, idempotencyKey: string) =>
    httpClient.put<ExportTemplateDto>(routes.byId(id), {
      name: draft.name,
      description: draft.description,
      sheetName: draft.sheetName,
      schemaVersion: draft.schemaVersion,
      columns: draft.columns,
      isActive: draft.isActive,
      expectedVersion,
      idempotencyKey,
    }),
  remove: (id: number, expectedVersion: number, idempotencyKey: string) =>
    httpClient.delete<void>(routes.byId(id), { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion, idempotencyKey }) }),
  setDefault: (id: number, expectedVersion: number, idempotencyKey: string) =>
    httpClient.post<ExportTemplateDto>(routes.setDefault(id), { expectedVersion, idempotencyKey }),
  preview: (draft: Pick<ExportTemplateDraft, 'targetScreen' | 'sourceType' | 'format' | 'columns'>) =>
    httpClient.post<Array<{ columnKey: string; header: string; value: unknown; valueType: string }>>(routes.preview, {
      targetScreen: draft.targetScreen,
      sourceType: draft.sourceType,
      format: draft.format,
      columns: draft.columns,
    }),
};

function validId(value: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error('Invalid export template id');
  return value;
}

export function exportTemplateCommandKey(action: string): string {
  return `export-template-${action}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
