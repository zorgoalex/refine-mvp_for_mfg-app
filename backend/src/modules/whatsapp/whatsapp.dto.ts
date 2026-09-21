import { humanName } from '../../shared/human-name-schema';
import { z } from "zod";
import { ApiError } from "../../common/errors/api-error";
import { replyVariables } from './whatsapp-template';

const code = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,63}$/);
const name = humanName(120);
const body = z.string().trim().min(1).max(4096);
const keywords = z
  .array(z.string().trim().min(1).max(120))
  .min(1)
  .max(50)
  .transform((values) => [
    ...new Set(values.map((value) => value.toLocaleLowerCase("ru-RU"))),
  ]);

const templateInput = z
  .object({ code, name, body, bodyMode: z.enum(['text', 'template']).default('text'), enabled: z.boolean().default(true) })
  .strict();
const templateUpdate = z
  .object({
    version: z.number().int().positive(),
    name: name.optional(),
    body: body.optional(),
    bodyMode: z.enum(['text', 'template']).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const ruleInput = z
  .object({
    code,
    name,
    matchMode: z.enum(["contains_any", "exact_any", "pattern_exact", "pattern_contains"]),
    replyMode: z.enum(['plain', 'quote']).default('plain'),
    keywords,
    templateId: z.number().int().positive(),
    priority: z.number().int().min(0).max(10000).default(100),
    enabled: z.boolean().default(true),
  })
  .strict();
const ruleUpdate = z
  .object({
    version: z.number().int().positive(),
    name: name.optional(),
    matchMode: z.enum(["contains_any", "exact_any", "pattern_exact", "pattern_contains"]).optional(),
    replyMode: z.enum(['plain', 'quote']).optional(),
    keywords: keywords.optional(),
    templateId: z.number().int().positive().optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
const restart = z
  .object({
    confirmed: z.literal(true),
    restrictionConfirmed: z.boolean().default(false),
  })
  .strict();

export type TemplateInput = z.infer<typeof templateInput>;
export type TemplateUpdate = z.infer<typeof templateUpdate>;
export type RuleInput = z.infer<typeof ruleInput>;
export type RuleUpdate = z.infer<typeof ruleUpdate>;

export const parseTemplateInput = (value: unknown) => {
  const input = parse(templateInput, value);
  if (input.bodyMode === 'template') replyVariables(input.body);
  return input;
};
export const parseTemplateUpdate = (value: unknown) =>
  parse(templateUpdate, value);
export const parseRuleInput = (value: unknown) => parse(ruleInput, value);
export const parseRuleUpdate = (value: unknown) => parse(ruleUpdate, value);
export const parseRestart = (value: unknown) => parse(restart, value);
export const parseReplyPreview = (value: unknown) => parse(z.object({
  matchMode: z.enum(['contains_any', 'exact_any', 'pattern_exact', 'pattern_contains']), keywords, body,
  bodyMode: z.enum(['text', 'template']), text: z.string().min(1).max(4096),
}).strict(), value);

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(422, "VALIDATION_ERROR", "Некорректные данные WhatsApp");
  return result.data;
}
