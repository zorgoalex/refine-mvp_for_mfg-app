import type { DatabaseClient } from '../../../database/database.types';

export interface BazisDraftPanel {
  bazisNodeId: number;
  name: string | null;
  position: string | null;
  designation: string | null;
  cumulativeQuantity: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  mainMaterialName: string | null;
  productName: string | null;
  productOrderNo: string | null;
  rawJson: Record<string, unknown> | null;
}

export interface BazisDraftRevision {
  bazisProjectName: string;
  revisionBazisOrderNo: string | null;
}

export interface BazisDraftMaterialMapping {
  target_kind: string;
  sheet_material_type_id: number | string | null;
  film_id: number | string | null;
}

export interface BazisDraftDetail {
  bazisNodeId: number;
  clientKey: string;
  detailName: string | null;
  height: number;
  width: number;
  quantity: number;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  millingTypeId: number;
  edgeTypeId: number;
  priority: number;
  basisProject: string | null;
  basisProduct: string | null;
  basisDesignation: string | null;
  basisData: string;
}

interface TargetOrderDuplicateRow {
  bazis_node_id: number | string;
  order_detail_id: number | string;
  matched_by: 'node_map' | 'basis_fields';
}

export function clientKeyForNode(bazisNodeId: number): string {
  return `bazis-node-${bazisNodeId}`;
}

export function collectUnmappedSheetNames(
  panels: ReadonlyArray<Pick<BazisDraftPanel, 'mainMaterialName'>>,
  mappings: Map<string, BazisDraftMaterialMapping>,
): string[] {
  const names = new Set<string>();
  for (const panel of panels) {
    if (!panel.mainMaterialName) {
      names.add('(панель без материала)');
      continue;
    }
    const mapping = mappings.get(`sheet:${panel.mainMaterialName.toLowerCase()}`);
    if (mapping?.target_kind !== 'sheet' || toNullableNumber(mapping.sheet_material_type_id) == null) {
      names.add(panel.mainMaterialName);
    }
  }
  return [...names];
}

export function buildDraftDetails(
  panels: ReadonlyArray<BazisDraftPanel>,
  mappings: Map<string, BazisDraftMaterialMapping>,
  revision: BazisDraftRevision,
): BazisDraftDetail[] {
  return panels.map((panel) => {
    const filmNames = extractFilmNames(panel.rawJson);
    const uniqueFilmNames = [...new Set(filmNames.map((name) => name.toLowerCase()))];
    const filmMapping =
      uniqueFilmNames.length === 1 ? mappings.get(`film:${uniqueFilmNames[0]}`) : undefined;
    const sheetMapping = panel.mainMaterialName
      ? mappings.get(`sheet:${panel.mainMaterialName.toLowerCase()}`)
      : undefined;

    return {
      bazisNodeId: panel.bazisNodeId,
      clientKey: clientKeyForNode(panel.bazisNodeId),
      detailName: panel.name,
      height: panel.lengthMm ?? 0,
      width: panel.widthMm ?? 0,
      quantity: panel.cumulativeQuantity ?? 0,
      sheetMaterialTypeId:
        sheetMapping?.target_kind === 'sheet'
          ? toNullableNumber(sheetMapping.sheet_material_type_id)
          : null,
      millingTypeId: 1,
      edgeTypeId: 1,
      filmId:
        filmMapping?.target_kind === 'film' ? toNullableNumber(filmMapping.film_id) : null,
      priority: 100,
      basisProject:
        panel.productOrderNo ?? revision.revisionBazisOrderNo ?? revision.bazisProjectName,
      basisProduct: panel.productName ?? null,
      basisDesignation: panel.designation,
      basisData: `${panel.position ?? ''}/${panel.designation ?? ''}/${panel.name ?? ''}`,
    };
  });
}

export async function computeTargetOrderDuplicates(
  db: Pick<DatabaseClient, 'query'>,
  input: { bazisProjectId: number; orderId: number; nodeIds: readonly number[] },
): Promise<Array<{ bazisNodeId: number; orderDetailId: number; matchedBy: 'node_map' | 'basis_fields' }>> {
  if (input.nodeIds.length === 0) {
    return [];
  }

  const result = await db.query<TargetOrderDuplicateRow>(
    `
    WITH sel AS (
      SELECT n.bazis_node_id,
             NULLIF(trim(n.designation), '') AS designation,
             NULLIF(trim(n."position"), '') AS position
      FROM bazis_nodes n
      WHERE n.bazis_node_id = ANY($3::bigint[])
    ),
    existing AS (
      SELECT m.node_id AS old_node_id,
             m.order_detail_id,
             NULLIF(trim(o.designation), '') AS designation,
             NULLIF(trim(o."position"), '') AS position
      FROM bazis_node_order_detail_map m
      JOIN bazis_nodes o ON o.bazis_node_id = m.node_id
      JOIN bazis_project_revisions r ON r.bazis_revision_id = o.revision_id
      WHERE m.order_id = $2
        AND m.order_detail_id IS NOT NULL
        AND r.bazis_project_id = $1
    )
    SELECT DISTINCT ON (sel.bazis_node_id, e.order_detail_id)
           sel.bazis_node_id,
           e.order_detail_id,
           CASE WHEN e.old_node_id = sel.bazis_node_id THEN 'node_map' ELSE 'basis_fields' END AS matched_by
    FROM sel
    JOIN existing e
      ON e.old_node_id = sel.bazis_node_id
      OR (
        sel.designation IS NOT NULL
        AND sel.position IS NOT NULL
        AND e.designation = sel.designation
        AND e.position = sel.position
      )
    ORDER BY sel.bazis_node_id, e.order_detail_id, (e.old_node_id = sel.bazis_node_id) DESC
    `,
    [input.bazisProjectId, input.orderId, input.nodeIds],
  );

  return result.rows.map((row) => ({
    bazisNodeId: Number(row.bazis_node_id),
    orderDetailId: Number(row.order_detail_id),
    matchedBy: row.matched_by,
  }));
}

function extractFilmNames(rawJson: Record<string, unknown> | null): string[] {
  if (!rawJson) {
    return [];
  }

  const result: string[] = [];
  for (const faceKey of ['ОблицовкаПласти1', 'ОблицовкаПласти2']) {
    const face = rawJson[faceKey];
    if (typeof face !== 'object' || face === null) {
      continue;
    }
    const plasti = (face as Record<string, unknown>)['Пласть'];
    const list = Array.isArray(plasti) ? plasti : plasti ? [plasti] : [];
    for (const plast of list) {
      if (typeof plast !== 'object' || plast === null) {
        continue;
      }
      const value = (plast as Record<string, unknown>)['Наименование'];
      if (typeof value === 'string' && value.trim().length > 0) {
        result.push(value.trim());
      }
    }
  }
  return result;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  return Number(value);
}
