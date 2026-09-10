import { z } from 'zod';

export const cadRecipeSchema = z.object({ code: z.string().min(1).max(80), version: z.string().min(1).max(40), parameters: z.record(z.string(), z.json()).default({}) }).strict();
export const cadGroupSchema = z.object({
  id: z.string().uuid(), sourceSnapshotId: z.string().uuid(), orderId: z.number().int().positive(), detailId: z.number().int().positive(),
  quantity: z.number().int().positive(), recipe: cadRecipeSchema.nullable(), xMm: z.number().finite(), yMm: z.number().finite(),
  rotationDeg: z.number().finite(), placementGroupId: z.string().uuid().optional(),
}).strict();
const point = z.object({ x: z.number(), y: z.number() });
const quality = z.enum(['exact', 'estimated', 'unavailable']);
export const cadVisualizationSchema = z.object({
  version: z.string(), quality, tolerance_mm: z.number().optional(),
  regions: z.array(z.object({ kind: z.enum(['material', 'pocket', 'groove', 'opening']), depth_mm: z.number().nullable(), quality,
    polygons: z.array(z.object({ outer: z.array(point), holes: z.array(z.array(point)) })) })),
  dimensions: z.array(z.object({ parameter: z.string(), kind: z.enum(['linear', 'angle', 'region']), value: z.number(), points: z.array(point) })),
  profiles: z.array(z.object({ path_id: z.string(), quality, reason: z.string().nullable().optional() })),
  schematic_path_ids: z.array(z.string()),
});
export const cadPathSchema = z.object({
  path_id: z.string(), layer: z.string(), operation: z.string(), points: z.array(point), closed: z.boolean(),
  depth_mm: z.number().nullable().optional(), tool_id: z.string().nullable().optional(), slot: z.number().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  segments: z.array(z.object({ segment_type: z.string(), start: point, end: point, center: point.optional(), radius_mm: z.number().optional(), clockwise: z.boolean().optional(), large_arc: z.boolean().optional() })).default([]),
});
export const cadFileSchema = z.object({ id: z.string(), name: z.string(), media_type: z.string(), sha256: z.string(), size_bytes: z.number().optional() });
const diagnostic = z.object({ code: z.string(), message: z.string().optional() }).passthrough();
export const cadPartResultSchema = z.object({
  input_recipe: cadRecipeSchema.nullable().optional(),
  geometry: z.object({ boundaries: z.array(cadPathSchema), milling: z.array(cadPathSchema), group_metadata: z.record(z.string(), z.unknown()).optional() }).optional(),
  visualization: cadVisualizationSchema.optional(), manufacturing_hash: z.string().optional(),
  svg: z.string().optional(), manifest: z.record(z.string(), z.unknown()).optional(),
  files: z.array(cadFileSchema).optional(), errors: z.array(diagnostic).optional(), warnings: z.array(diagnostic).optional(),
});
export const cadPreviewItemSchema = z.object({ part_id: z.string(), status: z.string(),
  snapshot_hash: z.string().nullable().optional(), manufacturing_hash: z.string().optional(), result: cadPartResultSchema.nullable() });
export const cadPreviewSchema = z.object({ items: z.array(cadPreviewItemSchema) });
export const cadJobSchema = z.object({
  id: z.string(), status: z.enum(['queued', 'running', 'succeeded', 'partial', 'failed']), total: z.number(), completed: z.number(),
  package_files: z.array(cadFileSchema).default([]),
  items: z.array(cadPreviewItemSchema),
});
export const cadParameterSchema = z.object({
  type: z.string(), default: z.json(), label: z.string().optional(), unit: z.string().optional(),
  manager_editable: z.boolean().default(false), integer: z.boolean().default(false), nullable: z.boolean().default(false),
  dimension: z.string().nullable().optional(), min: z.number().optional(), max: z.number().optional(),
  choices: z.array(z.json()).nullable().optional(),
});
export const cadCatalogSchema = z.object({ recipes: z.array(z.object({
  code: z.string(), version: z.string(), display_name: z.string(), status: z.string(), snapshot_hash: z.string(),
  defaults: z.record(z.string(), z.json()),
  parameter_schema: z.record(z.string(), cadParameterSchema),
  manager_ready: z.boolean().default(false), configuration_errors: z.array(diagnostic).default([]),
  available_tools: z.array(z.object({ id: z.string(), display_name: z.string() })).default([]),
  manager_policy: z.record(z.string(), z.unknown()).nullable().optional(),
})) });
export const cadEvaluationSchema = z.object({ items: z.array(z.object({ recipe: cadRecipeSchema,
  manager_allowed: z.boolean(), snapshot_hash: z.string().optional(), resolved_parameters: z.record(z.string(), z.json()).optional(), errors: z.array(diagnostic) })) });
export const cadReadinessSchema = z.object({ job_id: z.string(), ready: z.boolean(), items: z.array(z.object({
  part_id: z.string(), status: z.string(), ready: z.boolean(), manufacturing_hash: z.string().nullable(),
  approval: z.record(z.string(), z.unknown()).nullable(), errors: z.array(diagnostic),
})) });
export const cadApprovalReceiptSchema = z.object({ id: z.string(), actor: z.object({ id: z.number(), name: z.string() }), reason: z.string(),
  approved_at: z.number(), scope_hash: z.string(), manufacturing_hash: z.string(), job_id: z.string(), part_id: z.string() });
export type CadJob = z.infer<typeof cadJobSchema>;
export type CadPath = z.infer<typeof cadPathSchema>;
export type CadCatalog = z.infer<typeof cadCatalogSchema>;
export type CadFile = z.infer<typeof cadFileSchema>;
export type CadVisualization = z.infer<typeof cadVisualizationSchema>;
export type CadPreview = z.infer<typeof cadPreviewSchema>;
export type CadPreviewItem = z.infer<typeof cadPreviewItemSchema>;
export type CadParameter = z.infer<typeof cadParameterSchema>;
export type CadReadiness = z.infer<typeof cadReadinessSchema>;
export type CadApprovalReceipt = z.infer<typeof cadApprovalReceiptSchema>;
export interface CadSourceStatus { orderId: number; orderName: string; stale: boolean; changedDetailIds: number[] }
export interface CadExportReview {
  ready: boolean; reviewId: string | null; runId: string; version: number; variantName: string;
  sourceStatus: CadSourceStatus[]; readiness: CadReadiness; positions: number; quantity: number;
  changedGroupIds: string[]; expiresAt?: string;
}
export interface CadApprovalCommand { id: string; status: 'pending' | 'succeeded' | 'failed'; lastError: string | null; receipt: CadApprovalReceipt | null }
