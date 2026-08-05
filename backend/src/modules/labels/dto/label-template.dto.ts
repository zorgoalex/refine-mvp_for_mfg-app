import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.unknown());
const exportFormatSchema = z.enum(['bmp', 'png', 'emf']);

const conditionScalarSchema = z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]);
const existenceWhenSchema = z.object({
  field: z.string().trim().min(1).max(200),
  op: z.enum(['exists', 'not_empty']),
}).strict();
const compareWhenSchema = z.object({
  field: z.string().trim().min(1).max(200),
  op: z.enum(['equals', 'not_equals']),
  value: conditionScalarSchema,
}).strict();
const conditionBranchSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('current') }).strict(),
  z.object({ type: z.literal('field'), field: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('text'), value: z.string().max(1000) }).strict(),
  z.object({ type: z.literal('hidden') }).strict(),
]);
const ifElseConditionSchema = z.object({
  type: z.literal('if_else'),
  version: z.literal(1),
  when: z.union([existenceWhenSchema, compareWhenSchema]),
  then: conditionBranchSchema,
  else: conditionBranchSchema,
}).strict();
const legacyConditionSchema = z.union([existenceWhenSchema, compareWhenSchema]);
const labelElementConditionSchema = z.union([
  z.object({}).strict(),
  legacyConditionSchema,
  ifElseConditionSchema,
]);

const typographyV1Schema = z.object({
  version: z.literal(1),
  fontSizePt: z.number().finite().min(4).max(96),
  fontWeight: z.enum(['normal', 'bold']),
  italic: z.boolean(),
}).strict();
const editorMetadataV1Schema = z.object({
  version: z.literal(1),
  boundsMode: z.enum(['auto', 'manual']),
  groupId: z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N}._:-]+$/u).optional(),
}).strict();
const cutMapV1Schema = z.object({
  version: z.literal(1),
  fit: z.literal('contain'),
  highlightFill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  highlightStroke: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  flipHorizontal: z.boolean().optional(),
  flipVertical: z.boolean().optional(),
}).strict();
const labelElementStyleSchema = jsonObjectSchema.superRefine((style, ctx) => {
  // Existing unversioned keys are intentionally preserved. Only the new,
  // versioned namespaces are strict, so an old template can still be edited.
  if (Object.prototype.hasOwnProperty.call(style, 'typography')) {
    addNestedSchemaIssues(typographyV1Schema.safeParse(style.typography), ctx, ['typography']);
  }
  if (Object.prototype.hasOwnProperty.call(style, 'editor')) {
    addNestedSchemaIssues(editorMetadataV1Schema.safeParse(style.editor), ctx, ['editor']);
  }
  if (Object.prototype.hasOwnProperty.call(style, 'cutMap')) {
    addNestedSchemaIssues(cutMapV1Schema.safeParse(style.cutMap), ctx, ['cutMap']);
  }
  for (const [key, value] of Object.entries(style)) {
    if (key === 'typography' || key === 'editor' || key === 'cutMap') continue;
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.prototype.hasOwnProperty.call(value, 'version')
    ) {
      ctx.addIssue({ code: 'custom', path: [key, 'version'], message: `Unknown versioned style namespace: ${key}` });
    }
  }
});

function addNestedSchemaIssues(
  result: z.ZodSafeParseResult<unknown>,
  ctx: z.RefinementCtx,
  prefix: PropertyKey[] = [],
): void {
  if (result.success) return;
  for (const issue of result.error.issues) {
    ctx.addIssue({ code: 'custom', path: [...prefix, ...issue.path], message: issue.message });
  }
}

export const labelTemplateElementInputSchema = z
  .object({
    elementKey: z.string().trim().min(1).max(100),
    kind: z.enum(['text', 'line', 'rect', 'qr', 'cut_map']),
    sourceField: z.string().trim().min(1).max(200).nullable().optional(),
    staticText: z.string().max(1000).nullable().optional(),
    xMm: z.number().min(0),
    yMm: z.number().min(0),
    widthMm: z.number().min(0),
    heightMm: z.number().min(0),
    rotationDeg: z.number().optional(),
    zIndex: z.number().int().optional(),
    style: labelElementStyleSchema.optional(),
    condition: labelElementConditionSchema.optional(),
  })
  .strict()
  .superRefine((element, ctx) => {
    if (element.condition && 'type' in element.condition && element.condition.type === 'if_else' && element.kind !== 'text') {
      ctx.addIssue({ code: 'custom', path: ['condition'], message: 'if_else is supported only for text elements' });
    }
    if (element.kind === 'cut_map') {
      if (!cutMapV1Schema.safeParse(element.style?.cutMap).success) {
        ctx.addIssue({ code: 'custom', path: ['style', 'cutMap'], message: 'cut_map requires cutMap v1 style' });
      }
      if (element.widthMm <= 0 || element.heightMm <= 0) {
        ctx.addIssue({ code: 'custom', path: ['widthMm'], message: 'cut_map dimensions must be positive' });
      }
      if (element.sourceField != null || element.staticText != null) {
        ctx.addIssue({ code: 'custom', path: ['sourceField'], message: 'cut_map cannot bind text fields' });
      }
    }
  });

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
