import { z } from 'zod';
import { DISCRIMINANT_FIELDS, isStrongField, OCR_FIELD_CODES } from '../application/scan/ocr-field-catalog';
import type { OcrFieldCode } from '../application/scan/ocr-field-catalog';

const ocrRuleSchema = z
  .object({
    // Cast to a non-empty tuple of the literal OcrFieldCode union (not `[string, ...string[]]`)
    // so z.enum's inferred `.field` type stays `OcrFieldCode`, matching OcrTemplateRule['field']
    // downstream (labels.service.ts / labels.types.ts) instead of widening to plain `string`.
    field: z.enum(OCR_FIELD_CODES as [OcrFieldCode, ...OcrFieldCode[]]),
    sampleText: z.string().max(300).optional(),
    anchor: z.string().trim().max(64).nullish(),
  })
  .strict();

type OcrRuleInput = z.infer<typeof ocrRuleSchema>;

/** Shared cross-field validation for OCR template rule sets:
 *  - no duplicate `field` values (except 'ignore', which may repeat as a filler slot)
 *  - at least 2 rules whose field is a "strong" field (see ocr-field-catalog)
 *  - at least 1 discriminant: a dimensions/material rule, or any rule with a non-empty anchor
 */
function refineRules(rules: OcrRuleInput[], ctx: z.RefinementCtx): void {
  const seen = new Set<OcrFieldCode>();
  for (const rule of rules) {
    const field = rule.field as OcrFieldCode;
    if (field === 'ignore') continue;
    if (seen.has(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Поле "${field}" указано более одного раза`,
        path: ['rules'],
      });
    }
    seen.add(field);
  }

  const strongCount = rules.filter((rule) => isStrongField(rule.field as OcrFieldCode)).length;
  if (strongCount < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Шаблону нужно ≥2 strong-поля (order_number, detail_number, dimensions, material, quantity, date)',
      path: ['rules'],
    });
  }

  const hasDiscriminant = rules.some((rule) => {
    const field = rule.field as OcrFieldCode;
    if (DISCRIMINANT_FIELDS.has(field)) return true;
    return typeof rule.anchor === 'string' && rule.anchor.trim().length > 0;
  });
  if (!hasDiscriminant) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Шаблону нужен дискриминант (поле dimensions/material или anchor хотя бы у одного правила)',
      path: ['rules'],
    });
  }
}

const baseLabelOcrTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    rules: z.array(ocrRuleSchema).min(1).max(30),
    sampleLines: z.array(z.string().max(300)).max(100).default([]),
    isActive: z.boolean().default(true),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

export const createLabelOcrTemplateSchema = baseLabelOcrTemplateSchema.superRefine((val, ctx) =>
  refineRules(val.rules, ctx),
);

export const updateLabelOcrTemplateSchema = baseLabelOcrTemplateSchema
  .extend({ version: z.number().int().min(1) })
  .strict()
  .superRefine((val, ctx) => refineRules(val.rules, ctx));

export const deleteLabelOcrTemplateSchema = z
  .object({
    version: z.number().int().min(1),
    idempotencyKey: z.string().trim().min(8).max(200),
  })
  .strict();

/** Validates the `rules` JSON payload sent alongside a multipart image upload on the
 *  label-ocr-templates `test` route (template-config UI dry-run). Same rule shape as
 *  createLabelOcrTemplateSchema/updateLabelOcrTemplateSchema but without the cross-field
 *  refine() checks — a candidate rule set under test does not need to satisfy the
 *  persisted-template invariants (strong-field count, discriminant, no dupes). */
export const testOcrRulesSchema = z.array(ocrRuleSchema).min(1).max(30);
