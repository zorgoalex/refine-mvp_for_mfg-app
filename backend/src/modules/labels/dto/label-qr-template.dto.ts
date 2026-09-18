import { humanName } from '../../../shared/human-name-schema';
import { z } from 'zod';

export const createLabelQrTemplateSchema = z
  .object({
    name: humanName(200, 1),
    contentTemplate: z.string().trim().min(1).max(2000),
    errorCorrection: z.enum(['L', 'M', 'Q', 'H']),
    defaultSizeMm: z.number().positive().max(1000),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const updateLabelQrTemplateSchema = createLabelQrTemplateSchema
  .extend({ version: z.number().int().min(1) })
  .strict();

export const deleteLabelQrTemplateSchema = z
  .object({
    version: z.number().int().min(1),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();
