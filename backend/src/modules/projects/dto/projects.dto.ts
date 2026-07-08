import { z } from 'zod';

export const CODE_RE = /^[0-9A-Za-zА-Яа-яЁё-]{1,20}$/u;

export const updateProjectSchema = z
  .object({
    code: z.string().regex(CODE_RE, 'Код: буквы/цифры/дефис, до 20 символов').optional(),
    name: z.string().trim().min(1).max(300).optional(),
    notes: z.string().max(4000).nullable().optional(),
    expectedVersion: z.number().int().min(0),
  })
  .refine((value) => value.code !== undefined || value.name !== undefined || value.notes !== undefined, {
    message: 'Нет полей для изменения',
  });

export const listProjectsSchema = z.object({
  search: z.string().trim().max(100).optional(),
  clientId: z.coerce.number().int().positive().optional(),
  // z.coerce.boolean() would turn the query string "false" into true.
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
    .optional(),
});

export const moveOrderSchema = z
  .object({
    targetProjectId: z.number().int().positive().optional(),
    createNew: z.boolean().optional(),
    idempotencyKey: z.string().min(8).max(200),
  })
  .refine((value) => (value.targetProjectId != null) !== (value.createNew === true), {
    message: 'Укажите либо targetProjectId, либо createNew',
  });

export const mergeSchema = z.object({
  sourceProjectId: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(200),
});
