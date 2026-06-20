import type { TransactionClient } from '../../../database/database.types';
import { OrderValidationError, type OrderFieldError } from '../errors/order.errors';

/**
 * SP3 sheet-material order guards, SHARED by the order command (transaction manager)
 * AND snapshot import so both enforce identical rules. Split into:
 *  - tx-scoped reference validation (existence + dimensions + anti-injection), and
 *  - pure eligibility/no-clear rules over {incoming, stored} state.
 */

export interface SheetValidationHeader {
  sheetMaterialTypeId: number | null;
  materialId: number | null;
}

export interface SheetValidationDetail {
  /** Error path label, e.g. `details[0]`. */
  label: string;
  /** Existing detail id (matched to stored rows for no-clear); undefined for new rows. */
  detailId?: number;
  sheetMaterialTypeId: number | null;
  materialId: number | null;
  height: number;
  width: number;
}

export interface StoredSheetDetail {
  detailId: number;
  sheetMaterialTypeId: number | null;
}

const NEW_ONLY_MESSAGE = 'Листовые материалы доступны только для заказов, созданных в SP3';
const NO_CLEAR_MESSAGE =
  'Нельзя убрать листовой материал из позиции в SP3 (возврат к обычному материалу вне области)';
const NO_FLIP_MESSAGE =
  'Нельзя перевести существующую обычную позицию на листовой материал (доступно только для новых позиций)';

export function collectSheetTypeIds(
  header: SheetValidationHeader,
  details: readonly SheetValidationDetail[],
): number[] {
  const ids = new Set<number>();
  if (header.sheetMaterialTypeId != null) {
    ids.add(header.sheetMaterialTypeId);
  }
  for (const detail of details) {
    if (detail.sheetMaterialTypeId != null) {
      ids.add(detail.sheetMaterialTypeId);
    }
  }
  return [...ids];
}

/**
 * True when the save touches the sheet/shadow persistence path at all — either the
 * INCOMING payload carries a sheet id, OR the STORED order already has one (so editing
 * any field of a sheet order still runs the sheet path and requires the permission).
 */
export function orderTouchesSheet(input: {
  header: SheetValidationHeader;
  details: readonly SheetValidationDetail[];
  storedHeaderSheetId: number | null;
  storedDetailSheetIds: readonly StoredSheetDetail[];
}): boolean {
  if (input.header.sheetMaterialTypeId != null) return true;
  if (input.details.some((d) => d.sheetMaterialTypeId != null)) return true;
  if (input.storedHeaderSheetId != null) return true;
  return input.storedDetailSheetIds.some((d) => d.sheetMaterialTypeId != null);
}

/**
 * NEW-ONLY (keyed on the durable `sheet_eligible` marker) + NO-CLEAR rules. Pure —
 * the caller supplies stored state. Throws OrderValidationError (422) on violation.
 */
export function assertSheetEligibilityAndNoClear(input: {
  eligible: boolean;
  storedHeaderSheetId: number | null;
  storedDetailSheetIds: readonly StoredSheetDetail[];
  header: SheetValidationHeader;
  details: readonly SheetValidationDetail[];
}): void {
  const errors: OrderFieldError[] = [];

  if (!input.eligible) {
    // A genuine pre-SP3 order (sheet_eligible=false) stays legacy forever: reject ANY
    // incoming non-null sheet id anywhere.
    if (input.header.sheetMaterialTypeId != null) {
      errors.push({ field: 'header.sheetMaterialTypeId', message: NEW_ONLY_MESSAGE });
    }
    input.details.forEach((detail) => {
      if (detail.sheetMaterialTypeId != null) {
        errors.push({ field: `${detail.label}.sheetMaterialTypeId`, message: NEW_ONLY_MESSAGE });
      }
    });
  }

  // NO-CLEAR (applies regardless of eligibility): a stored non-null sheet id must not be
  // cleared to NULL — that would strand the hidden shadow material_id as a legacy material.
  if (input.storedHeaderSheetId != null && input.header.sheetMaterialTypeId == null) {
    errors.push({ field: 'header.sheetMaterialTypeId', message: NO_CLEAR_MESSAGE });
  }
  const storedById = new Map<number, number | null>();
  for (const stored of input.storedDetailSheetIds) {
    storedById.set(stored.detailId, stored.sheetMaterialTypeId);
  }
  input.details.forEach((detail) => {
    if (detail.detailId == null) return;
    if (!storedById.has(detail.detailId)) return;
    const storedSheetId = storedById.get(detail.detailId) ?? null;
    if (storedSheetId != null && detail.sheetMaterialTypeId == null) {
      errors.push({ field: `${detail.label}.sheetMaterialTypeId`, message: NO_CLEAR_MESSAGE });
    }
    // NO-FLIP (detail-level new-only): an existing detail stored as legacy (NULL) must not
    // become a sheet detail. Brand-new rows (no detailId, or detailId absent from stored)
    // may set a sheet id freely on an eligible order.
    if (storedSheetId == null && detail.sheetMaterialTypeId != null) {
      errors.push({ field: `${detail.label}.sheetMaterialTypeId`, message: NO_FLIP_MESSAGE });
    }
  });

  if (errors.length > 0) {
    throw new OrderValidationError(errors);
  }
}

interface SheetSpecRow {
  sheet_material_type_id: number | string;
  width_mm: number | string | null;
  height_mm: number | string | null;
}

interface ShadowFlagRow {
  material_id: number | string;
  is_sheet_shadow: boolean;
  shadow_of_sheet_material_type_id: number | string | null;
}

function num(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

/**
 * Anti-injection: a legacy ref (sheetMaterialTypeId null) must NOT point at a shadow
 * material; a sheet ref's supplied material_id must not belong to a DIFFERENT sheet's
 * shadow. Returns the collected field errors (does not throw) so callers can merge them.
 *
 * SECURITY: this MUST run on EVERY save — including legacy-looking ones that don't touch
 * the sheet path — so a payload can't smuggle a shadow `material_id` with a null sheet id
 * (which would create Variant-A sheet semantics without the backend command boundary).
 */
async function collectShadowInjectionErrors(
  tx: TransactionClient,
  header: SheetValidationHeader,
  details: readonly SheetValidationDetail[],
): Promise<OrderFieldError[]> {
  const errors: OrderFieldError[] = [];
  const materialIds = new Set<number>();
  if (header.materialId != null && header.sheetMaterialTypeId == null) {
    materialIds.add(header.materialId);
  }
  for (const detail of details) {
    if (detail.materialId != null && detail.materialId !== 0) {
      materialIds.add(detail.materialId);
    }
  }
  if (materialIds.size === 0) return errors;

  const flags = await tx.query<ShadowFlagRow>(
    `SELECT material_id, is_sheet_shadow, shadow_of_sheet_material_type_id
       FROM materials WHERE material_id = ANY($1::bigint[])`,
    [[...materialIds]],
  );
  const flagById = new Map<number, ShadowFlagRow>();
  for (const row of flags.rows) {
    flagById.set(num(row.material_id), row);
  }
  const isShadow = (materialId: number): boolean =>
    flagById.get(materialId)?.is_sheet_shadow === true;

  if (header.sheetMaterialTypeId == null && header.materialId != null && isShadow(header.materialId)) {
    errors.push({
      field: 'header.materialId',
      message: 'material_id references a hidden sheet shadow material',
    });
  }
  details.forEach((detail) => {
    if (detail.materialId == null || detail.materialId === 0) return;
    if (detail.sheetMaterialTypeId == null) {
      if (isShadow(detail.materialId)) {
        errors.push({
          field: `${detail.label}.materialId`,
          message: 'material_id references a hidden sheet shadow material',
        });
      }
    } else {
      // sheet detail with a supplied shadow material_id belonging to a DIFFERENT sheet.
      const flag = flagById.get(detail.materialId);
      if (
        flag?.is_sheet_shadow === true &&
        flag.shadow_of_sheet_material_type_id != null &&
        num(flag.shadow_of_sheet_material_type_id) !== detail.sheetMaterialTypeId
      ) {
        errors.push({
          field: `${detail.label}.materialId`,
          message: 'material_id is a shadow of a different sheet material',
        });
      }
    }
  });
  return errors;
}

/**
 * Standalone shadow anti-injection guard, runnable on EVERY save (legacy included).
 * Throws OrderValidationError (422) on violation.
 */
export async function validateNoShadowInjection(
  tx: TransactionClient,
  header: SheetValidationHeader,
  details: readonly SheetValidationDetail[],
): Promise<void> {
  const errors = await collectShadowInjectionErrors(tx, header, details);
  if (errors.length > 0) {
    throw new OrderValidationError(errors);
  }
}

/**
 * Tx-scoped reference validation: existence of referenced sheet types, dimension fit of
 * each sheet detail against the sheet spec (both orientations), and anti-injection of
 * shadow `material_id`s. Throws OrderValidationError (422) — never a raw 500/FK error.
 */
export async function validateSheetReferences(
  tx: TransactionClient,
  header: SheetValidationHeader,
  details: readonly SheetValidationDetail[],
): Promise<void> {
  const errors: OrderFieldError[] = [];

  // 1. Existence + dimensions of referenced sheet types.
  const sheetIds = collectSheetTypeIds(header, details);
  const specById = new Map<number, SheetSpecRow>();
  if (sheetIds.length > 0) {
    const specs = await tx.query<SheetSpecRow>(
      `SELECT sheet_material_type_id, width_mm, height_mm
         FROM sheet_material_types WHERE sheet_material_type_id = ANY($1::bigint[])`,
      [sheetIds],
    );
    for (const row of specs.rows) {
      specById.set(num(row.sheet_material_type_id), row);
    }
    if (header.sheetMaterialTypeId != null && !specById.has(header.sheetMaterialTypeId)) {
      errors.push({
        field: 'header.sheetMaterialTypeId',
        message: `sheet_material_type ${header.sheetMaterialTypeId} does not exist`,
      });
    }
    details.forEach((detail) => {
      if (detail.sheetMaterialTypeId != null && !specById.has(detail.sheetMaterialTypeId)) {
        errors.push({
          field: `${detail.label}.sheetMaterialTypeId`,
          message: `sheet_material_type ${detail.sheetMaterialTypeId} does not exist`,
        });
      }
    });
  }

  // Dimension fit per sheet detail (both orientations: max fits max, min fits min).
  details.forEach((detail) => {
    if (detail.sheetMaterialTypeId == null) return;
    const spec = specById.get(detail.sheetMaterialTypeId);
    if (!spec || spec.width_mm == null || spec.height_mm == null) return;
    const sheetMax = Math.max(num(spec.width_mm), num(spec.height_mm));
    const sheetMin = Math.min(num(spec.width_mm), num(spec.height_mm));
    const detailMax = Math.max(detail.height, detail.width);
    const detailMin = Math.min(detail.height, detail.width);
    const tolerance = 0.01;
    if (detailMax > sheetMax + tolerance || detailMin > sheetMin + tolerance) {
      errors.push({
        field: `${detail.label}.height`,
        message: `Размер детали (${detail.height}×${detail.width}) превышает лист (${num(spec.height_mm)}×${num(spec.width_mm)})`,
      });
    }
  });

  // 2. Anti-injection of shadow material_ids (shared with the always-run guard).
  errors.push(...(await collectShadowInjectionErrors(tx, header, details)));

  if (errors.length > 0) {
    throw new OrderValidationError(errors);
  }
}
