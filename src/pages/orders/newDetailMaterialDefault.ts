import type { OrderDetail } from '../../types/orders';

const validMaterialId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

/**
 * Resolves material for a new detail row. Persisted rows never participate:
 * the first new row in an existing order starts from the catalog default.
 * Later new rows inherit the closest preceding new row that has a material.
 */
export function newDetailMaterialDefault(
  details: readonly OrderDetail[],
  catalogDefault: number | undefined,
  beforeDetailNumber = Number.POSITIVE_INFINITY,
): number | undefined {
  const previousNewDetail = details
    .filter((detail) =>
      detail.detail_id == null &&
      (detail.detail_number ?? 0) < beforeDetailNumber &&
      validMaterialId(detail.sheet_material_type_id),
    )
    .sort((left, right) => (right.detail_number ?? 0) - (left.detail_number ?? 0))[0];

  const inheritedMaterialId = previousNewDetail?.sheet_material_type_id;
  return validMaterialId(inheritedMaterialId) ? inheritedMaterialId : catalogDefault;
}

export function insertedDetailMaterialDefault(
  previousDetail: OrderDetail,
  catalogDefault: number | undefined,
): number | undefined {
  return previousDetail.detail_id == null && validMaterialId(previousDetail.sheet_material_type_id)
    ? previousDetail.sheet_material_type_id
    : catalogDefault;
}
