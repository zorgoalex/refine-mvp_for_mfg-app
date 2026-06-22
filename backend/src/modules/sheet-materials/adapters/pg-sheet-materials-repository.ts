import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import {
  buildSheetMaterialAuditEvent,
  buildSheetMaterialDeniedEvent,
  SHEET_MATERIALS_AUDIT_EVENTS,
} from '../application/sheet-materials-audit';
import { validateSheetMaterialTypeInput } from '../application/sheet-materials-validation';
// VARIANT B (Task 7b): buildShadowMaterialAuditEvent / syncLinkedShadow / ShadowContext
// imports removed — no live call path invokes shadow sync anymore.
// Delete this comment in shadow-column cleanup (follow-up plan).
import {
  SheetMaterialNotFoundError,
  SheetMaterialStaleVersionError,
} from '../errors/sheet-materials.errors';
import type {
  CreateSheetMaterialTypeCommand,
  DeactivateSheetMaterialTypeCommand,
  GetSheetMaterialTypeQuery,
  ListSheetMaterialTypesQuery,
  SheetMaterialsPermissionDeniedInput,
  SheetMaterialsPort,
  SheetMaterialTypeDto,
  UpdateSheetMaterialTypeCommand,
} from '../application/sheet-materials.types';

const SELECT_COLUMNS = `sheet_material_type_id, name, material_type_id, unit_id, thickness_mm, width_mm, height_mm,
  supplier_id, vendor_id, supplier_article, texture, color, ref_key_1c::text, is_active, version`;

/**
 * Backend-owned sheet-material-type CRUD (SP1). Every write is audited in-tx
 * (sheet_material.* events, before/after diff), optimistic-version-guarded, and
 * write-time validated. Reads (list/getById) are served here too; the Refine UI
 * reads via Hasura, but these endpoints give a non-Hasura read path.
 */
export class PgSheetMaterialsRepository implements SheetMaterialsPort {
  constructor(private readonly database: DatabaseService) {}

  async list(query: ListSheetMaterialTypesQuery): Promise<SheetMaterialTypeDto[]> {
    const result = await this.database.query(
      `SELECT ${SELECT_COLUMNS}
       FROM sheet_material_types
       WHERE ($1::boolean IS TRUE OR is_active = true)
       ORDER BY name`,
      [query.includeInactive ?? false],
    );
    return result.rows.map(mapRow);
  }

  async getById(query: GetSheetMaterialTypeQuery): Promise<SheetMaterialTypeDto> {
    const result = await this.database.query(
      `SELECT ${SELECT_COLUMNS} FROM sheet_material_types WHERE sheet_material_type_id = $1`,
      [query.id],
    );
    if (result.rowCount === 0) {
      throw new SheetMaterialNotFoundError(query.id);
    }
    return mapRow(result.rows[0]);
  }

  async create(command: CreateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto> {
    validateSheetMaterialTypeInput(command.input);
    const input = command.input;
    return this.writeCatalog(() =>
      this.database.transaction(async (tx) => {
        await setSessionUser(tx, command.currentUser.id);
        const inserted = await tx.query(
          `INSERT INTO sheet_material_types
             (name, material_type_id, unit_id, thickness_mm, width_mm, height_mm,
              supplier_id, vendor_id, supplier_article, texture, color, ref_key_1c, is_active, created_by, edited_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::uuid,COALESCE($13,true),$14,$14)
           RETURNING ${SELECT_COLUMNS}`,
          [
            input.name,
            input.materialTypeId,
            input.unitId,
            input.thicknessMm,
            input.widthMm,
            input.heightMm,
            input.supplierId ?? null,
            input.vendorId ?? null,
            input.supplierArticle ?? null,
            input.texture ?? null,
            input.color ?? null,
            input.refKey1c || null,
            input.isActive ?? null,
            numOrNull(command.currentUser.id),
          ],
        );
        const row = mapRow(inserted.rows[0]);
        await auditService.record(
          tx,
          buildSheetMaterialAuditEvent({
            event: SHEET_MATERIALS_AUDIT_EVENTS.created,
            currentUser: command.currentUser,
            sheetMaterialTypeId: row.sheetMaterialTypeId,
            before: null,
            after: diffShape(row),
            requestId: command.requestId,
          }),
        );
        return row;
      }),
    );
  }

  async update(command: UpdateSheetMaterialTypeCommand): Promise<SheetMaterialTypeDto> {
    validateSheetMaterialTypeInput(command.input);
    const input = command.input;
    return this.writeCatalog(() =>
      this.database.transaction(async (tx) => {
        await setSessionUser(tx, command.currentUser.id);
        const existing = await tx.query(
          `SELECT ${SELECT_COLUMNS} FROM sheet_material_types WHERE sheet_material_type_id = $1 FOR UPDATE`,
          [command.id],
        );
        if (existing.rowCount === 0) {
          throw new SheetMaterialNotFoundError(command.id);
        }
        const before = mapRow(existing.rows[0]);
        if (before.version !== command.expectedVersion) {
          throw new SheetMaterialStaleVersionError(command.expectedVersion, before.version);
        }
        const updated = await tx.query(
          `UPDATE sheet_material_types SET
             name=$2, material_type_id=$3, unit_id=$4, thickness_mm=$5, width_mm=$6, height_mm=$7,
             supplier_id=$8, vendor_id=$9, supplier_article=$10, texture=$11, color=$12, ref_key_1c=$13::uuid,
             is_active=COALESCE($14, is_active), version=version+1, edited_by=$15, updated_at=now()
           WHERE sheet_material_type_id=$1
           RETURNING ${SELECT_COLUMNS}`,
          [
            command.id,
            input.name,
            input.materialTypeId,
            input.unitId,
            input.thicknessMm,
            input.widthMm,
            input.heightMm,
            input.supplierId ?? null,
            input.vendorId ?? null,
            input.supplierArticle ?? null,
            input.texture ?? null,
            input.color ?? null,
            input.refKey1c || null,
            input.isActive ?? null,
            numOrNull(command.currentUser.id),
          ],
        );
        const after = mapRow(updated.rows[0]);
        await auditService.record(
          tx,
          buildSheetMaterialAuditEvent({
            event: SHEET_MATERIALS_AUDIT_EVENTS.updated,
            currentUser: command.currentUser,
            sheetMaterialTypeId: after.sheetMaterialTypeId,
            before: diffShape(before),
            after: diffShape(after),
            requestId: command.requestId,
          }),
        );
        // VARIANT B (Task 7b): eager shadow sync removed — migration 034 hard-deletes all
        // synthetic shadow rows; re-calling syncShadowForSheetType here would resurrect them.
        return after;
      }),
    );
  }

  async deactivate(command: DeactivateSheetMaterialTypeCommand): Promise<void> {
    await this.database.transaction(async (tx) => {
      await setSessionUser(tx, command.currentUser.id);
      const existing = await tx.query<{ version: number; is_active: boolean }>(
        `SELECT version, is_active FROM sheet_material_types WHERE sheet_material_type_id = $1 FOR UPDATE`,
        [command.id],
      );
      if (existing.rowCount === 0) {
        throw new SheetMaterialNotFoundError(command.id);
      }
      const currentVersion = toNum(existing.rows[0].version);
      if (currentVersion !== command.expectedVersion) {
        throw new SheetMaterialStaleVersionError(command.expectedVersion, currentVersion);
      }
      await tx.query(
        `UPDATE sheet_material_types SET is_active=false, version=version+1, edited_by=$2, updated_at=now()
         WHERE sheet_material_type_id=$1`,
        [command.id, numOrNull(command.currentUser.id)],
      );
      await auditService.record(
        tx,
        buildSheetMaterialAuditEvent({
          event: SHEET_MATERIALS_AUDIT_EVENTS.deactivated,
          currentUser: command.currentUser,
          sheetMaterialTypeId: command.id,
          before: { isActive: Boolean(existing.rows[0].is_active) },
          after: { isActive: false },
          requestId: command.requestId,
        }),
      );
      // VARIANT B (Task 7b): eager shadow sync removed — migration 034 hard-deletes all
      // synthetic shadow rows; re-calling syncShadowForSheetType here would resurrect them.
    });
  }

  /**
   * VARIANT B: dead — no live call path invokes this anymore (Task 7b).
   * Migration 034 hard-deletes all synthetic shadow rows; calling this would resurrect them.
   * Delete in shadow-column cleanup (follow-up plan).
   *
   * @deprecated — no callers since Task 7b; kept compiled per one-release no-op policy.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async syncShadowForSheetType(
    _tx: TransactionClient,
    _sheetMaterialTypeId: number,
    _actorUserId: string | number,
    _requestId: string,
  ): Promise<void> {
    // VARIANT B: dead — delete in shadow-column cleanup
  }

  async recordPermissionDenied(input: SheetMaterialsPermissionDeniedInput): Promise<void> {
    try {
      await auditService.recordDenied(this.database, buildSheetMaterialDeniedEvent(input));
    } catch {
      /* denied-audit is best-effort; never throw into the 403 path */
    }
  }

  /** Map a unique-constraint violation (duplicate name) to a 409 instead of 500. */
  private async writeCatalog<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        throw new ApiError(409, 'SHEET_MATERIAL_CONFLICT', 'Sheet material type name already exists', {});
      }
      throw error;
    }
  }
}

function mapRow(r: Record<string, unknown>): SheetMaterialTypeDto {
  return {
    sheetMaterialTypeId: toNum(r.sheet_material_type_id),
    name: String(r.name),
    materialTypeId: toNum(r.material_type_id),
    unitId: toNum(r.unit_id),
    thicknessMm: Number(r.thickness_mm),
    widthMm: Number(r.width_mm),
    heightMm: Number(r.height_mm),
    supplierId: r.supplier_id == null ? null : toNum(r.supplier_id),
    vendorId: r.vendor_id == null ? null : toNum(r.vendor_id),
    supplierArticle: r.supplier_article == null ? null : String(r.supplier_article),
    texture: r.texture == null ? null : Boolean(r.texture),
    color: r.color == null ? null : String(r.color),
    refKey1c: r.ref_key_1c == null ? null : String(r.ref_key_1c),
    isActive: Boolean(r.is_active),
    version: toNum(r.version),
  };
}

function diffShape(s: SheetMaterialTypeDto): Record<string, unknown> {
  return {
    name: s.name,
    materialTypeId: s.materialTypeId,
    unitId: s.unitId,
    thicknessMm: s.thicknessMm,
    widthMm: s.widthMm,
    heightMm: s.heightMm,
    supplierId: s.supplierId,
    vendorId: s.vendorId,
    supplierArticle: s.supplierArticle,
    texture: s.texture,
    color: s.color,
    refKey1c: s.refKey1c,
    isActive: s.isActive,
  };
}

function toNum(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function numOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function setSessionUser(tx: TransactionClient, userId: string | number): Promise<void> {
  await tx.query('SELECT set_session_user($1)', [String(userId)]);
}
