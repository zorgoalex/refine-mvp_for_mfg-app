import { ApiError } from '../../../common/errors/api-error';
import type { TransactionClient } from '../../../database/database.types';
import type { AuditEvent } from '../../../common/audit/audit-event.types';
import { computeDiff } from '../../../common/audit/audit-diff';

/**
 * Mirrored sheet-type attributes copied onto the synthetic shadow `materials` row.
 * `width/height/thickness` are sheet-only dimensions (not stored on `materials`) and
 * are mirrored into the audit metadata so drift is queryable; `unitId/materialTypeId/
 * isActive` are mirrored onto real `materials` columns.
 */
export interface ShadowMirroredState {
  unitId: number;
  materialTypeId: number;
  isActive: boolean;
  widthMm: number | null;
  heightMm: number | null;
  thicknessMm: number | null;
}

export interface ShadowMaterialAuditInput {
  materialId: number;
  sheetMaterialTypeId: number;
  action: 'shadow_create' | 'shadow_sync';
  name: string;
  mirrored: ShadowMirroredState;
  /** Previous mirrored state for a `shadow_sync` (before/after diff); null on create. */
  before?: {
    name: string;
    isActive: boolean;
    unitId: number;
    materialTypeId: number;
  } | null;
}

export interface ShadowContext {
  actorUserId: number | null;
  requestId?: string;
  /** 'backend-orders-command' | 'backend-sheet-materials' — caller-supplied (Critic round 19). */
  source: string;
  clientId?: number | null;
  orderId?: number | null;
}

/**
 * Raised when every disambiguated shadow-name candidate is taken. Surfaces as a 409
 * (not a raw 500) from BOTH the orders command and the sheet-materials write path,
 * because the shared allocator throws it directly (Critic round 29).
 */
export class ShadowNameConflictError extends ApiError {
  constructor(sheetMaterialTypeId: number, baseName: string) {
    super(409, 'SHADOW_NAME_CONFLICT', 'Не удалось подобрать уникальное имя для листового материала', {
      sheetMaterialTypeId,
      baseName,
    });
  }
}

interface SheetSpecRow {
  name: string;
  material_type_id: number | string;
  unit_id: number | string;
  is_active: boolean;
  width_mm: number | string | null;
  height_mm: number | string | null;
  thickness_mm: number | string | null;
}

/**
 * Build the query/report-ready audit event for a shadow create/sync. Shared so the
 * order-save path AND the sheet-materials eager-sync path write the IDENTICAL shape
 * (distinct event names, normalized related sheet_material_type, mirrored metadata).
 * `source` and related order/client dims come from the caller-supplied ShadowContext.
 */
export function buildShadowMaterialAuditEvent(
  input: ShadowMaterialAuditInput,
  ctx: ShadowContext,
): AuditEvent {
  const after = {
    name: input.name,
    isActive: input.mirrored.isActive,
    unitId: input.mirrored.unitId,
    materialTypeId: input.mirrored.materialTypeId,
  };
  const before = input.before
    ? {
        name: input.before.name,
        isActive: input.before.isActive,
        unitId: input.before.unitId,
        materialTypeId: input.before.materialTypeId,
      }
    : null;
  return {
    event: input.action === 'shadow_create' ? 'materials.shadow_create' : 'materials.shadow_sync',
    entityType: 'material',
    entityId: input.materialId,
    actorUserId: ctx.actorUserId ?? null,
    requestId: ctx.requestId ?? 'shadow-material',
    source: ctx.source,
    relatedOrderId: ctx.orderId ?? null,
    relatedClientId: ctx.clientId ?? null,
    relatedEntities: [{ entityType: 'sheet_material_type', entityId: input.sheetMaterialTypeId }],
    before,
    after,
    diff: computeDiff(before, after),
    metadata: { name: input.name, mirrored: input.mirrored } as unknown as Record<string, unknown>,
  };
}

function toNumber(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNullableNumber(value: number | string | null): number | null {
  return value === null ? null : toNumber(value);
}

/**
 * Variant A bridge: `order_details.material_id` is NOT NULL, so every sheet detail must
 * also point at a `materials` row that MIRRORS the sheet type. The bridge is ALWAYS a
 * DEDICATED SYNTHETIC shadow (is_sheet_shadow=true, shadow_of_sheet_material_type_id=X,
 * sheet_material_type_id NULL) — NEVER a real SP2-linked catalog row (those are
 * read-only and decoupled, so cut/SP2 are unaffected and legacy material_id consumers
 * always see fresh mirrored attrs). HIGH-PRIO TECH DEBT — closure = Variant B. See TODO.md.
 *
 * Idempotent: returns the existing shadow's id if present (drift-syncing mirrored fields),
 * or creates one. Runs INSIDE the order DB transaction so a failed order save rolls back
 * any shadow row.
 */
interface ParsedSheetSpec {
  name: string;
  unitId: number;
  materialTypeId: number;
  isActive: boolean;
  mirrored: ShadowMirroredState;
}

interface ParsedShadowRow {
  id: number;
  name: string;
  isActive: boolean;
  unitId: number;
  materialTypeId: number;
}

async function lockSheetShadow(tx: TransactionClient, sheetMaterialTypeId: number): Promise<void> {
  // BIGINT-safe advisory lock (released at commit/rollback), backstopped by
  // uq_materials_shadow_of_sheet_material_type_id.
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('sheet_shadow_material:' || $1::text, 0))`,
    [String(sheetMaterialTypeId)],
  );
}

async function loadSheetSpecForShadow(
  tx: TransactionClient,
  sheetMaterialTypeId: number,
): Promise<ParsedSheetSpec | null> {
  const result = await tx.query<SheetSpecRow>(
    `SELECT name, material_type_id, unit_id, is_active, width_mm, height_mm, thickness_mm
       FROM sheet_material_types WHERE sheet_material_type_id = $1`,
    [sheetMaterialTypeId],
  );
  const spec = result.rows[0];
  if (!spec) return null;
  const unitId = toNumber(spec.unit_id);
  const materialTypeId = toNumber(spec.material_type_id);
  return {
    name: spec.name,
    unitId,
    materialTypeId,
    isActive: spec.is_active,
    mirrored: {
      unitId,
      materialTypeId,
      isActive: spec.is_active,
      widthMm: toNullableNumber(spec.width_mm),
      heightMm: toNullableNumber(spec.height_mm),
      thicknessMm: toNullableNumber(spec.thickness_mm),
    },
  };
}

async function findLinkedShadow(
  tx: TransactionClient,
  sheetMaterialTypeId: number,
): Promise<ParsedShadowRow | null> {
  // Looked up ONLY by the shadow link, so a real SP2 row sharing sheet_material_type_id
  // is never matched.
  const result = await tx.query<{
    material_id: number | string;
    material_name: string;
    is_active: boolean;
    unit_id: number | string;
    material_type_id: number | string;
  }>(
    `SELECT material_id, material_name, is_active, unit_id, material_type_id
       FROM materials WHERE shadow_of_sheet_material_type_id = $1 LIMIT 1`,
    [sheetMaterialTypeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: toNumber(row.material_id),
    name: row.material_name,
    isActive: row.is_active,
    unitId: toNumber(row.unit_id),
    materialTypeId: toNumber(row.material_type_id),
  };
}

/**
 * Drift-guarded sync of an EXISTING shadow row to its sheet spec. Shared by order-save
 * (lazy) and the sheet-material reference write (eager, Task 3b) so the rule is identical.
 * Compute the EXPECTED disambiguated name FIRST (excluding this row), then compare
 * (Critic round 30): comparing against spec.name would be ALWAYS-different → fake
 * shadow_sync audits + pointless UPDATEs on every save. A true no-op stays a no-op.
 */
async function syncShadowIfDrift(
  tx: TransactionClient,
  spec: ParsedSheetSpec,
  sheetMaterialTypeId: number,
  ctx: ShadowContext,
  audit: (input: ShadowMaterialAuditInput) => Promise<void>,
  row: ParsedShadowRow,
): Promise<void> {
  const expectedName = await allocateUniqueShadowName(tx, spec.name, sheetMaterialTypeId, row.id);
  const drift =
    row.name !== expectedName ||
    row.isActive !== spec.isActive ||
    row.unitId !== spec.unitId ||
    row.materialTypeId !== spec.materialTypeId;
  if (!drift) return;
  await tx.query(
    `UPDATE materials SET material_name = $2, is_active = $3, unit_id = $4,
            material_type_id = $5, edited_by = $6, updated_at = now()
      WHERE material_id = $1`,
    [row.id, expectedName, spec.isActive, spec.unitId, spec.materialTypeId, ctx.actorUserId],
  );
  await audit({
    materialId: row.id,
    sheetMaterialTypeId,
    action: 'shadow_sync',
    name: expectedName,
    mirrored: spec.mirrored,
    before: {
      name: row.name,
      isActive: row.isActive,
      unitId: row.unitId,
      materialTypeId: row.materialTypeId,
    },
  });
}

export async function resolveShadowMaterialId(
  tx: TransactionClient,
  sheetMaterialTypeId: number,
  ctx: ShadowContext,
  audit: (input: ShadowMaterialAuditInput) => Promise<void>,
): Promise<number> {
  await lockSheetShadow(tx, sheetMaterialTypeId);

  const spec = await loadSheetSpecForShadow(tx, sheetMaterialTypeId);
  if (!spec) {
    throw new Error(`sheet_material_type ${sheetMaterialTypeId} not found`);
  }

  // 1. Reuse the existing DEDICATED SHADOW, drift-syncing it.
  const row = await findLinkedShadow(tx, sheetMaterialTypeId);
  if (row) {
    await syncShadowIfDrift(tx, spec, sheetMaterialTypeId, ctx, audit, row);
    return row.id;
  }

  // 2. Create a new synthetic shadow (sheet_material_type_id NULL → invisible to cut/SP2;
  //    ref_key_1c NULL → no 1C unique clash). Allocate a unique name via the shared helper.
  const name = await allocateUniqueShadowName(tx, spec.name, sheetMaterialTypeId, null);
  const ins = await tx.query<{ material_id: number | string }>(
    `INSERT INTO materials (material_name, unit_id, material_type_id, is_active, is_sheet_shadow, shadow_of_sheet_material_type_id, created_by)
       VALUES ($1, $2, $3, $4, true, $5, $6)
     RETURNING material_id`,
    [name, spec.unitId, spec.materialTypeId, spec.isActive, sheetMaterialTypeId, ctx.actorUserId],
  );
  const id = toNumber(ins.rows[0].material_id);
  await audit({
    materialId: id,
    sheetMaterialTypeId,
    action: 'shadow_create',
    name,
    mirrored: spec.mirrored,
    before: null,
  });
  return id;
}

/**
 * Eager sync (Task 3b): when the sheet-material reference is updated/deactivated, sync its
 * linked synthetic shadow in the SAME tx. NO-OP if no shadow exists yet (the sheet type was
 * never used in an order) — never creates one. Reuses the EXACT drift-guarded sync above,
 * so behavior matches the lazy order-save path.
 */
export async function syncLinkedShadow(
  tx: TransactionClient,
  sheetMaterialTypeId: number,
  ctx: ShadowContext,
  audit: (input: ShadowMaterialAuditInput) => Promise<void>,
): Promise<void> {
  await lockSheetShadow(tx, sheetMaterialTypeId);
  const spec = await loadSheetSpecForShadow(tx, sheetMaterialTypeId);
  if (!spec) return;
  const row = await findLinkedShadow(tx, sheetMaterialTypeId);
  if (!row) return;
  await syncShadowIfDrift(tx, spec, sheetMaterialTypeId, ctx, audit, row);
}

/**
 * Deterministic, collision-safe unique-name allocator shared by create AND sync.
 * ALWAYS DISAMBIGUATES (Critic round 26): the shadow NEVER claims the plain sheet
 * name. If it did, Task 10b hides the shadow from the catalog/pickers, and a later
 * real-material create/rename to that same plain name would fail on uq_materials_name
 * against an INVISIBLE row. So the shadow name is always `<sheet name> [лист #id]`
 * (then `#id-2..` on the rare further clash), length-trimmed to VARCHAR(200).
 * The shadow's name is never user-visible anyway (display uses the server COALESCE
 * sheet name via sheet_material_type_id), so disambiguation has no UX cost.
 * Excludes `excludeMaterialId` (the row being synced). Runs under the per-sheet
 * advisory lock; the final INSERT/UPDATE still relies on uq_materials_name as the
 * hard guard. Throws ShadowNameConflictError (→409) if all candidates are taken.
 */
export async function allocateUniqueShadowName(
  tx: TransactionClient,
  baseName: string,
  sheetMaterialTypeId: number,
  excludeMaterialId: number | null,
): Promise<string> {
  for (let k = 1; k < 100000; k++) {
    // OPEN-ENDED (Critic round 30): a fixed cap is not collision-safe; high cap only
    // guards against a pathological loop.
    const suffix = ` [лист #${sheetMaterialTypeId}${k === 1 ? '' : '-' + k}]`;
    const name = `${baseName.slice(0, 200 - suffix.length)}${suffix}`;
    const taken = await tx.query(
      `SELECT 1 FROM materials WHERE material_name = $1 AND ($2::bigint IS NULL OR material_id <> $2) LIMIT 1`,
      [name, excludeMaterialId],
    );
    if (taken.rowCount === 0) {
      return name;
    }
  }
  throw new ShadowNameConflictError(sheetMaterialTypeId, baseName);
}
