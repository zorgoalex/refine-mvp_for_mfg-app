import { z } from 'zod';

const unsafeSvg = /<\s*(?:script|foreignObject)\b|\bon[a-z]+\s*=|\b(?:href|xlink:href)\s*=|(?:javascript:|data:|https?:|file:)/i;
export const svgRenderSourceSchema = z.object({
  viewBox: z.object({xMm: z.number().min(-10000).max(10000), yMm: z.number().min(-10000).max(10000),
    widthMm: z.number().positive().max(10000), heightMm: z.number().positive().max(10000)}).strict(),
  body: z.string().trim().min(1).max(60000).refine(body => !unsafeSvg.test(body), 'Unsafe SVG fragment'),
}).strict();
/** Physical geometry without a business identity. Persisted unchanged through every SVG render path. */
export const svgRenderContourSchema = z.object({
  sourceElementId: z.string().trim().min(1).max(240),
  xMm: z.number().min(-2).max(10000), yMm: z.number().min(-2).max(10000),
  placedWidthMm: z.number().positive().max(10000), placedHeightMm: z.number().positive().max(10000),
  labelLines: z.array(z.string().max(200)).max(4),
  sourceSvg: svgRenderSourceSchema.nullable().optional(),
}).strict();
export type SvgRenderContour = z.infer<typeof svgRenderContourSchema>;

export function normalizeSvgRenderContours(value: unknown, sheet: {widthMm: number; heightMm: number} | null): SvgRenderContour[] {
  if (!Array.isArray(value) || !sheet || !Number.isFinite(sheet.widthMm) || !Number.isFinite(sheet.heightMm)) return [];
  const seen = new Set<string>();
  return value.slice(0, 5000).flatMap(raw => {
    const parsed = svgRenderContourSchema.safeParse(raw);
    if (!parsed.success) return [];
    const c = parsed.data;
    if (c.xMm + c.placedWidthMm > sheet.widthMm + 2 || c.yMm + c.placedHeightMm > sheet.heightMm + 2) return [];
    const key = [c.sourceElementId,c.xMm,c.yMm,c.placedWidthMm,c.placedHeightMm].join('|');
    if (seen.has(key)) return [];
    seen.add(key);
    return [c];
  });
}
