import { z } from 'zod';

const text = (max: number) => z.string().max(max);
const nonEmpty = (max: number) => text(max).trim().min(1);
const positiveMm = z.number().positive().max(99_999_999.99);
const edgeMm = z.number().min(0).max(99_999_999.99);

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

export const createBazisCutSetSchema = z.object({
  name: nonEmpty(200).optional(),
  orderId: z.number().int().positive(),
  detailIds: z.array(z.number().int().positive()).min(1).max(500),
}).strict();

export const addBazisCutSetDetailsSchema = z.object({
  orderId: z.number().int().positive(),
  detailIds: z.array(z.number().int().positive()).min(1).max(500),
  expectedVersion: z.number().int().min(0),
}).strict();

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

export const listBazisCutSetsSchema = z.object({
  search: z.string().trim().max(200).optional().default(''),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(25),
}).strict();

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
