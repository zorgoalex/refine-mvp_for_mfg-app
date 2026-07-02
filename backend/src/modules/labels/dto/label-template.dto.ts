import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());
const exportFormatSchema = z.enum(['bmp', 'png', 'emf']);

export const labelTemplateElementInputSchema = z
  .object({
    elementKey: z.string().trim().min(1).max(100),
    kind: z.enum(['text', 'line', 'rect', 'qr']),
    sourceField: z.string().trim().min(1).max(200).nullable().optional(),
    staticText: z.string().max(1000).nullable().optional(),
    xMm: z.number().min(0),
    yMm: z.number().min(0),
    widthMm: z.number().min(0),
    heightMm: z.number().min(0),
    rotationDeg: z.number().optional(),
    zIndex: z.number().int().optional(),
    style: jsonObjectSchema.optional(),
    condition: jsonObjectSchema.optional(),
  })
  .strict();

export const createLabelTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    canvasWidthMm: z.number().positive(),
    canvasHeightMm: z.number().positive(),
    dpi: z.number().int().positive(),
    defaultExportFormats: z.array(exportFormatSchema).min(1).max(3),
    customFieldSchema: jsonObjectSchema.default({}),
    elements: z.array(labelTemplateElementInputSchema).default([]),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const updateLabelTemplateSchema = createLabelTemplateSchema
  .extend({
    version: z.number().int().min(1),
  })
  .strict();

export const deleteLabelTemplateSchema = z
  .object({
    version: z.number().int().min(1),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
