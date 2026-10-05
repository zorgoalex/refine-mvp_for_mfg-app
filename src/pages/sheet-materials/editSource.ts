import type { SheetMaterialTypeDto, SheetMaterialTypeInput } from '../../api/sheetMaterialsApi';

/** Запись листового материала из Hasura (snake_case) — запасной источник формы. */
export type SheetMaterialHasuraRecord = Record<string, any> & { version?: number };

/**
 * Черновик формы и версия для PUT — из ОДНОГО снимка: backend (`GET /sheet-material-types/:id`), а если он не ответил —
 * запись Hasura. Поля одного чтения с версией другого дали бы сохранение устаревших значений без 409.
 * Новые поля (тип/категория номенклатуры, примечание) есть только в снимке backend.
 */
export function sheetMaterialEditSource(
  snapshot: SheetMaterialTypeDto | undefined,
  record: SheetMaterialHasuraRecord | undefined,
): { values: Partial<SheetMaterialTypeInput>; expectedVersion: number | undefined; fromBackend: boolean } | null {
  if (snapshot) {
    return {
      fromBackend: true,
      expectedVersion: snapshot.version,
      values: {
        name: snapshot.name, materialTypeId: snapshot.materialTypeId, unitId: snapshot.unitId,
        thicknessMm: snapshot.thicknessMm, widthMm: snapshot.widthMm, heightMm: snapshot.heightMm,
        supplierId: snapshot.supplierId, vendorId: snapshot.vendorId, supplierArticle: snapshot.supplierArticle,
        texture: snapshot.texture, color: snapshot.color, refKey1c: snapshot.refKey1c,
        isActive: snapshot.isActive, isCuttable: snapshot.isCuttable, sortOrder: snapshot.sortOrder,
        nomenclatureType: snapshot.nomenclatureType ?? undefined,
        nomenclatureCategory: snapshot.nomenclatureCategory ?? undefined,
        note: snapshot.note ?? undefined,
      },
    };
  }
  if (!record) return null;
  return {
    fromBackend: false,
    expectedVersion: record.version,
    values: {
      name: record.name, materialTypeId: record.material_type_id, unitId: record.unit_id,
      thicknessMm: record.thickness_mm, widthMm: record.width_mm, heightMm: record.height_mm,
      supplierId: record.supplier_id, vendorId: record.vendor_id, supplierArticle: record.supplier_article,
      texture: record.texture, color: record.color, refKey1c: record.ref_key_1c,
      isActive: record.is_active, isCuttable: record.is_cuttable ?? true, sortOrder: record.sort_order,
    },
  };
}
