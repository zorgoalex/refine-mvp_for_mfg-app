import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const updateOrderLabelDataSchema = z
  .object({
    templateId: z.number().int().positive(),
    rows: z
      .array(
        z
          .object({
            detailId: z.number().int().positive(),
            version: z.number().int().min(1).nullable().optional(),
            bazisFields: jsonObjectSchema.optional(),
            customFields: jsonObjectSchema.optional(),
            clearStaleFieldIds: z.array(z.string().trim().min(1).max(200)).optional(),
          })
          .strict(),
      )
      .default([]),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

const detailFiltersSchema = z
  .object({
    detailIds: z.array(z.number().int().positive()).optional(),
  })
  .strict();

const cutMapSelectionSchema = z.object({
  detailId: z.number().int().positive(),
  copyIndex: z.number().int().positive(),
  cutResultPlacementId: z.number().int().positive(),
}).strict();

const cutMapSourceSchema = z.enum(['regular', 'bath']);
const telegramCutMapFallbackVersionSchema = z.literal('v1');
const cutSheetDetailInstanceSchema = z.object({
  detailId: z.number().int().positive(),
  instance: z.number().int().positive(),
}).strict();
const cutSheetScopeSchema = z.object({
  cutJobId: z.number().int().positive(),
  cutGroupId: z.number().int().positive(),
  sheetIndex: z.number().int().min(0),
  detailInstances: z.array(cutSheetDetailInstanceSchema).min(1).max(5000),
}).strict();
const cutMapFallbackImageSchema = z.object({
  packetId: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  storageKey: z.string().trim().min(1).max(220),
  contentType: z.string().trim().min(1).max(120).nullable().optional(),
  sizeBytes: z.number().int().positive().nullable().optional(),
}).strict();

export const previewOrderLabelsSchema = z
  .object({
    templateId: z.number().int().positive(),
    templateVersion: z.number().int().min(1),
    detailFilters: detailFiltersSchema.optional(),
    useBasisFields: z.boolean().optional().default(true),
    cutMapSource: cutMapSourceSchema.optional(),
    cutMapSelections: z.array(cutMapSelectionSchema).max(5000).optional(),
    telegramCutMapFallbackVersion: telegramCutMapFallbackVersionSchema.optional(),
  })
  .strict();

export const generateOrderLabelsSchema = previewOrderLabelsSchema
  .extend({
    previewToken: z.string().trim().min(20).max(4000),
    exportFormats: z.array(z.enum(['bmp', 'png', 'emf'])).min(1).max(3),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const previewDetailLabelsSchema = z
  .object({
    templateId: z.number().int().positive(),
    templateVersion: z.number().int().min(1),
    detailIds: z.array(z.number().int().positive()).min(1).max(5000),
    useBasisFields: z.boolean().optional().default(true),
    detailInstances: z.array(cutSheetDetailInstanceSchema).min(1).max(5000).optional(),
    cutSheetScope: cutSheetScopeSchema.optional(),
    cutMapFallbackImage: cutMapFallbackImageSchema.optional(),
  })
  .strict();

export const generateDetailLabelsSchema = previewDetailLabelsSchema
  .extend({
    previewToken: z.string().trim().min(20).max(4000),
    exportFormats: z.array(z.enum(['bmp', 'png', 'emf'])).min(1).max(3),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
