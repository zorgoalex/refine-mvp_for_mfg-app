import { z } from 'zod';

const text = (max: number) => z.string().max(max);
const nonEmpty = (max: number) => text(max).trim().min(1);
const positiveMm = z.number().positive().max(99_999_999.99);
const edgeMm = z.number().min(0).max(99_999_999.99);
const positiveId = z.number().int().positive();
const sourceIds = z.array(positiveId).max(500).default([]);
const pickerIdArray = z.array(positiveId).max(500).default([]);
const pickerTextArray = z.array(z.string().trim().min(1).max(200)).max(500).default([]);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const pickerPeriodShape = { dateFrom: dateOnly, dateTo: dateOnly } as const;
const pickerCriteriaObject = z.object({
  ...pickerPeriodShape,
  orderIds: pickerIdArray,
  clientIds: pickerIdArray,
  sheetMaterialTypeIds: pickerIdArray,
  millingTypeIds: pickerIdArray,
  bazisKeys: pickerTextArray,
  designEngineerIds: pickerIdArray,
  dowelingOrderIds: pickerIdArray,
  excludedDetailIds: z.array(positiveId).max(2000).default([]),
}).strict();

function validatePickerPeriod(
  value: { dateFrom: string; dateTo: string },
  context: z.RefinementCtx,
): void {
  const from = parseDateOnly(value.dateFrom);
  const to = parseDateOnly(value.dateTo);
  if (from === null || to === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dateFrom'], message: 'Некорректный период' });
    return;
  }
  if (from > to) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dateTo'], message: 'Конец периода раньше начала' });
    return;
  }
  const calendarDays = Math.floor((to - from) / 86_400_000) + 1;
  if (calendarDays > 366) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['dateTo'], message: 'Период не может превышать 366 дней' });
  }
}

function parseDateOnly(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) return null;
  return timestamp;
}

export const bazisCutDetailFieldsSchema = z.object({
  cutEnabled: z.boolean(),
  materialType: nonEmpty(100),
  materialName: nonEmpty(200),
  materialArticle: text(200),
  thicknessMm: positiveMm,
  position: z.string(),
  partName: nonEmpty(300),
  finishedLengthMm: positiveMm,
  finishedWidthMm: positiveMm,
  cutLengthMm: positiveMm,
  cutWidthMm: positiveMm,
  quantity: z.number().int().positive().max(1_000_000),
  orientation: text(50),
  groove: text(500),
  l1Name: text(200),
  l1Designation: text(200),
  l1ThicknessMm: edgeMm,
  l2Name: text(200),
  l2Designation: text(200),
  l2ThicknessMm: edgeMm,
  w1Name: text(200),
  w1Designation: text(200),
  w1ThicknessMm: edgeMm,
  w2Name: text(200),
  w2Designation: text(200),
  w2ThicknessMm: edgeMm,
  priority: z.number().int().min(0).max(1_000_000).nullable(),
  comment: text(2000),
  customProperty: text(2000),
  glue: text(500),
  milling: text(200),
  route: text(500),
  film: text(200),
}).strict();

function requireAtLeastOneSource(value: { detailIds: number[]; hdfDetailIds: number[] }, context: z.RefinementCtx): void {
  if (value.detailIds.length === 0 && value.hdfDetailIds.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['detailIds'], message: 'Нужно выбрать детали' });
  }
}

export const createBazisCutSetSchema = z.object({
  name: nonEmpty(200).optional(),
  orderId: z.number().int().positive(),
  detailIds: sourceIds,
  hdfDetailIds: sourceIds,
}).strict().superRefine(requireAtLeastOneSource);

export const addBazisCutSetDetailsSchema = z.object({
  orderId: z.number().int().positive(),
  detailIds: sourceIds,
  hdfDetailIds: sourceIds,
  expectedVersion: z.number().int().min(0),
}).strict().superRefine(requireAtLeastOneSource);

export const renameBazisCutSetSchema = z.object({
  name: nonEmpty(200),
  expectedVersion: z.number().int().min(0),
}).strict();

export const updateBazisCutSetDetailSchema = bazisCutDetailFieldsSchema.extend({
  expectedVersion: z.number().int().min(0),
}).strict();

export const deleteBazisCutSetDetailSchema = z.object({
  expectedVersion: z.number().int().min(0),
}).strict();

export const deleteBazisCutSetSchema = z.object({
  expectedVersion: z.number().int().min(0),
}).strict();

export const listBazisCutSetsSchema = z.object({
  search: z.string().trim().max(200).optional().default(''),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(25),
}).strict();

export const bazisCutPickerPeriodSchema = z.object(pickerPeriodShape).strict()
  .superRefine(validatePickerPeriod);

export const bazisCutPickerCriteriaSchema = pickerCriteriaObject.superRefine(validatePickerPeriod);

export const searchBazisCutPickerSchema = z.object({
  ...pickerCriteriaObject.shape,
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(100).default(25),
}).strict().superRefine(validatePickerPeriod);

export const createBazisCutSetFromPickerSchema = z.object({
  criteria: bazisCutPickerCriteriaSchema,
  criteriaHash: z.string().regex(/^[a-f0-9]{64}$/),
  details: z.array(z.object({
    detailId: positiveId,
    selectionToken: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(500),
}).strict();

export const bazisCutOrderMembershipsSchema = z.object({
  orderId: z.coerce.number().int().positive(),
}).strict();

export type BazisCutPickerCriteria = z.infer<typeof bazisCutPickerCriteriaSchema>;

export type BazisCutDetailFields = z.infer<typeof bazisCutDetailFieldsSchema>;

export interface BazisCutSourceRefDto {
  id: number;
  label: string;
  deleted?: boolean;
}

export interface BazisCutSetSummaryDto {
  bazisCutSetId: number;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  quantity: number;
  positionCount: number;
  totalAreaM2: number;
  orders: BazisCutSourceRefDto[];
  projects: BazisCutSourceRefDto[];
  bazisProjects: BazisCutSourceRefDto[];
  bazisOrders: BazisCutSourceRefDto[];
}

export interface BazisCutSetDetailDto extends BazisCutDetailFields {
  bazisCutSetDetailId: number;
  bazisCutSetId: number;
  sortOrder: number;
  sourceOrderDetailId: number | null;
  sourceOrderId: number | null;
  sourceOrderDeleted: boolean;
  sourceProjectId: number | null;
  sourceBazisProjectId: number | null;
  sourceBazisRevisionId: number | null;
  sourceBazisNodeId: number | null;
  sourceOrderName: string;
  sourceOrderFullNumber: string;
  sourceProjectCode: string;
  sourceBazisProjectName: string;
  sourceBazisOrderNo: string;
  sourceBazisProductName: string;
  sourceBathCutNumber: string;
  createdAt: string;
  updatedAt: string;
}

export interface BazisCutSetDto extends BazisCutSetSummaryDto {
  createdBy: number | null;
  updatedBy: number | null;
  details: BazisCutSetDetailDto[];
}

export interface BazisCutSetListDto {
  items: BazisCutSetSummaryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface BazisCutMutationResultDto {
  set: BazisCutSetDto;
  addedCount?: number;
}

export interface BazisCutDeleteSetResultDto {
  deleted: true;
  set: BazisCutSetSummaryDto;
}

export interface BazisCutPickerOptionDto {
  id: number;
  label: string;
}

export interface BazisCutPickerBazisOptionDto {
  key: string;
  label: string;
  type: 'project' | 'order' | 'legacy';
}

export interface BazisCutPickerFacetsDto {
  orders: BazisCutPickerOptionDto[];
  clients: BazisCutPickerOptionDto[];
  sheetMaterials: BazisCutPickerOptionDto[];
  millingTypes: BazisCutPickerOptionDto[];
  bazisSources: BazisCutPickerBazisOptionDto[];
  designEngineers: BazisCutPickerOptionDto[];
  dowelingOrders: BazisCutPickerOptionDto[];
}

export interface BazisCutPickerMembershipDto {
  bazisCutSetId: number;
  name: string;
}

export interface BazisCutPickerDetailDto {
  detailId: number;
  orderId: number;
  orderNumber: string;
  orderDate: string;
  clientName: string;
  detailNumber: number;
  detailName: string;
  quantity: number;
  heightMm: number;
  widthMm: number;
  areaM2: number;
  materialName: string;
  millingName: string;
  bazisLabel: string;
  designEngineerName: string;
  dowelingOrderName: string;
  bazisCutSets: BazisCutPickerMembershipDto[];
  selectionToken: string;
}

export interface BazisCutPickerSearchDto {
  items: BazisCutPickerDetailDto[];
  page: number;
  pageSize: number;
  total: number;
  totalQuantity: number;
  totalAreaM2: number;
  criteriaHash: string;
}

export interface BazisCutOrderMembershipsDto {
  orderId: number;
  details: Array<{
    detailId: number;
    bazisCutSets: BazisCutPickerMembershipDto[];
  }>;
}
