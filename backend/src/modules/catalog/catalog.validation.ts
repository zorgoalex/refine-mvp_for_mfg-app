import { z } from 'zod';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';

const price = z.string().regex(/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/, 'Цена: от 0 до 9999999999.99, максимум два знака после точки')
  .transform(value => { const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(2, '0')}`; }).nullable();
export const itemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(80).nullable().transform(value => value || null),
  kind: z.enum(['made_to_order', 'stock_item', 'service']),
  unitId: z.number().int().min(1).max(32767),
  basePrice: price,
  description: z.string().trim().max(2000),
  isActive: z.boolean(),
  refKey1c: z.string().trim().transform(value => value || null).nullable()
    .refine(value => value === null || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value), '1C_key должен быть UUID')
    .transform(value => value?.toLowerCase() ?? null).optional(),
  sortOrder: z.number().int().min(-32768).max(32767).optional(),
}).strict();
const updateSchema = itemSchema.extend({ expectedVersion: z.number().int().positive().max(2147483646) }).strict();
const integerQuery = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe());
const listSchema = z.object({
  q: z.string().trim().max(200).default(''),
  kind: z.enum(['made_to_order', 'stock_item', 'service']).optional(),
  active: z.enum(['true', 'false', 'all']).default('true'),
  limit: integerQuery.pipe(z.number().min(1).max(100)).default(25),
  offset: integerQuery.pipe(z.number().min(0).max(2147483647)).default(0),
}).strict();
export type CatalogInput = z.output<typeof itemSchema>;
export type CatalogQuery = z.output<typeof listSchema>;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(422, 'CATALOG_INVALID_INPUT', 'Проверьте поля товара или услуги', {
    issues: result.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message })),
  });
  return result.data;
}
export function parseItem(value: unknown, update = false): CatalogInput & { expectedVersion?: number } {
  return update ? parse(updateSchema, value) : parse(itemSchema, value);
}
export function parseList(value: unknown): CatalogQuery { return parse(listSchema, value); }
export function parseCatalogId(value: string): number {
  return parse(integerQuery.pipe(z.number().positive().safe()), value);
}
export function parseCommandKey(value: unknown): string {
  return parse(z.string().trim().min(8).max(200), value);
}
export function requireCatalogPermission(user: CurrentUser | undefined, write = false): CurrentUser {
  if (!user) throw new ApiError(401, 'AUTH_REQUIRED', 'Требуется вход');
  if (!user.permissions.includes('references.manage') && (write || !user.permissions.includes('references.view'))) {
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для справочника «Товары и услуги»');
  }
  return user;
}
