import { z } from 'zod';
import {
  EXPORT_TEMPLATE_FORMATS,
  EXPORT_TEMPLATE_SCHEMA_VERSION,
  EXPORT_TEMPLATE_SOURCES,
  EXPORT_TEMPLATE_TARGETS,
  type ExportExpression,
} from '../application/export-template.types';

const scalarSchema = z.union([z.string().max(10_000), z.number().finite(), z.boolean(), z.null()]);
const fieldSchema = z.object({ type: z.literal('field'), field: z.string().trim().min(1).max(200) }).strict();
const constantSchema = z.object({ type: z.literal('constant'), value: scalarSchema }).strict();
const emptySchema = z.object({ type: z.literal('empty') }).strict();

export const exportExpressionSchema: z.ZodType<ExportExpression> = z.lazy(() => z.discriminatedUnion('type', [
  fieldSchema,
  constantSchema,
  emptySchema,
  z.object({
    type: z.literal('concat'),
    parts: z.array(exportExpressionSchema).min(1).max(20),
  }).strict(),
  z.object({
    type: z.literal('if_else'),
    when: z.object({
      left: exportExpressionSchema,
      op: z.enum(['exists', 'not_empty', 'equals', 'not_equals', 'contains', 'gt', 'gte', 'lt', 'lte']),
      right: exportExpressionSchema.optional(),
    }).strict(),
    then: exportExpressionSchema,
    else: exportExpressionSchema,
  }).strict(),
  z.object({
    type: z.literal('string_fn'),
    fn: z.enum(['trim', 'upper', 'lower']),
    input: exportExpressionSchema,
  }).strict(),
  z.object({
    type: z.literal('number_fn'),
    fn: z.enum(['round', 'floor', 'ceil', 'abs']),
    input: exportExpressionSchema,
    digits: z.number().int().min(0).max(6).optional(),
  }).strict(),
  z.object({
    type: z.literal('math'),
    fn: z.enum(['add', 'subtract', 'multiply', 'divide']),
    parts: z.array(exportExpressionSchema).min(2).max(20),
  }).strict(),
])) as z.ZodType<ExportExpression>;

export const exportTemplateColumnSchema = z.object({
  columnKey: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  header: z.string().trim().min(1).max(200),
  expression: exportExpressionSchema,
}).strict();

const columnsSchema = z.array(exportTemplateColumnSchema).min(1).max(100)
  .superRefine((columns, ctx) => {
    const keys = new Set<string>();
    columns.forEach((column, index) => {
      if (keys.has(column.columnKey)) {
        ctx.addIssue({ code: 'custom', path: [index, 'columnKey'], message: 'Column key must be unique' });
      }
      keys.add(column.columnKey);
    });
  });

const sheetNameSchema = z.string().trim().min(1).max(31).refine((value) => !/[\[\]:*?/\\]/.test(value), {
  message: 'Sheet name contains an invalid XLS character',
});
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const createExportTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  targetScreen: z.enum(EXPORT_TEMPLATE_TARGETS),
  sourceType: z.enum(EXPORT_TEMPLATE_SOURCES),
  format: z.enum(EXPORT_TEMPLATE_FORMATS),
  sheetName: sheetNameSchema,
  schemaVersion: z.literal(EXPORT_TEMPLATE_SCHEMA_VERSION).default(EXPORT_TEMPLATE_SCHEMA_VERSION),
  columns: columnsSchema,
  isActive: z.boolean().default(true),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const updateExportTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  sheetName: sheetNameSchema,
  schemaVersion: z.literal(EXPORT_TEMPLATE_SCHEMA_VERSION),
  columns: columnsSchema,
  isActive: z.boolean(),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const deleteExportTemplateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export const setDefaultExportTemplateSchema = deleteExportTemplateSchema;

export const previewExportTemplateSchema = z.object({
  targetScreen: z.enum(EXPORT_TEMPLATE_TARGETS),
  sourceType: z.enum(EXPORT_TEMPLATE_SOURCES),
  format: z.enum(EXPORT_TEMPLATE_FORMATS),
  columns: columnsSchema,
}).strict();

export const listExportTemplatesQuerySchema = z.object({
  targetScreen: z.enum(EXPORT_TEMPLATE_TARGETS).optional(),
  sourceType: z.enum(EXPORT_TEMPLATE_SOURCES).optional(),
  format: z.enum(EXPORT_TEMPLATE_FORMATS).optional(),
  includeInactive: z.enum(['true', 'false']).optional().default('false'),
}).strict();

export const availableExportTemplatesQuerySchema = z.object({
  targetScreen: z.enum(EXPORT_TEMPLATE_TARGETS),
  sourceType: z.enum(EXPORT_TEMPLATE_SOURCES),
  format: z.enum(EXPORT_TEMPLATE_FORMATS),
}).strict();

export type CreateExportTemplateInput = z.infer<typeof createExportTemplateSchema>;
export type UpdateExportTemplateInput = z.infer<typeof updateExportTemplateSchema>;
