import { z } from 'zod';

export const cadRecipeSchema = z.object({ code: z.string().min(1).max(80), version: z.string().min(1).max(40), parameters: z.record(z.string(), z.json()).default({}) }).strict();
export const cadGroupSchema = z.object({
  id: z.string().uuid(), sourceSnapshotId: z.string().uuid(), orderId: z.number().int().positive(), detailId: z.number().int().positive(),
  quantity: z.number().int().positive(), recipe: cadRecipeSchema.nullable(), xMm: z.number().finite(), yMm: z.number().finite(),
  rotationDeg: z.number().finite(), placementGroupId: z.string().uuid().optional(),
}).strict();
const point = z.object({ x: z.number(), y: z.number() });
export const cadPathSchema = z.object({
  path_id: z.string(), layer: z.string(), operation: z.string(), points: z.array(point), closed: z.boolean(),
  depth_mm: z.number().nullable().optional(), tool_id: z.string().nullable().optional(), slot: z.number().nullable().optional(),
  segments: z.array(z.object({ segment_type: z.string(), start: point, end: point, radius_mm: z.number().optional(), clockwise: z.boolean().optional(), large_arc: z.boolean().optional() })).default([]),
});
export const cadFileSchema = z.object({ id: z.string(), name: z.string(), media_type: z.string(), sha256: z.string(), size_bytes: z.number().optional() });
const diagnostic = z.object({ code: z.string(), message: z.string().optional() }).passthrough();
export const cadJobSchema = z.object({
  id: z.string(), status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed']), total: z.number(), completed: z.number(),
  package_files: z.array(cadFileSchema).default([]),
  items: z.array(z.object({ part_id: z.string(), status: z.string(), snapshot_hash: z.string().nullable().optional(), result: z.object({
    input_recipe: cadRecipeSchema.nullable().optional(),
    geometry: z.object({ boundaries: z.array(cadPathSchema), milling: z.array(cadPathSchema) }).optional(),
    svg: z.string().optional(), manifest: z.record(z.string(), z.unknown()).optional(),
    files: z.array(cadFileSchema).optional(), errors: z.array(diagnostic).optional(), warnings: z.array(diagnostic).optional(),
  }).nullable() })),
});
export const cadCatalogSchema = z.object({ recipes: z.array(z.object({
  code: z.string(), version: z.string(), display_name: z.string(), status: z.string(), snapshot_hash: z.string(),
  defaults: z.record(z.string(), z.json()),
  parameter_schema: z.record(z.string(), z.object({ type: z.string(), default: z.json() })),
})) });
export type CadJob = z.infer<typeof cadJobSchema>;
export type CadPath = z.infer<typeof cadPathSchema>;
export type CadCatalog = z.infer<typeof cadCatalogSchema>;
export type CadFile = z.infer<typeof cadFileSchema>;
