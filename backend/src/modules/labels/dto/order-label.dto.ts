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

export const previewOrderLabelsSchema = z
  .object({
    templateId: z.number().int().positive(),
    templateVersion: z.number().int().min(1),
    detailFilters: detailFiltersSchema.optional(),
    useBasisFields: z.boolean().optional().default(true),
    cutMapSelections: z.array(cutMapSelectionSchema).max(5000).optional(),
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
  })
  .strict();

export const generateDetailLabelsSchema = previewDetailLabelsSchema
  .extend({
    previewToken: z.string().trim().min(20).max(4000),
    exportFormats: z.array(z.enum(['bmp', 'png', 'emf'])).min(1).max(3),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
