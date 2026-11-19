import type { DatabaseClient } from '../../../database/database.types';
import type { OrderDto } from '../../orders/dto/order.dto';
import type {
  SaveOrderDetailDto,
  SaveOrderDowelingLinkDto,
  SaveOrderDto,
  SaveOrderHeaderDto,
  SaveOrderPaymentDto,
  SaveOrderRequirementDto,
  SaveOrderWorkshopDto,
} from '../../orders/dto/save-order.dto';
import {
  BAZIS_MILLING_PROPERTY_NAMES,
  bazisPanelLegacyFilmName,
  bazisPanelPropertyFilmName,
  bazisPanelUniqueFaceFilm,
  bazisUserPropertyValue,
  normalizeBazisReferenceName,
} from '../application/bazis-panel-film';

export { normalizeBazisReferenceName };

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
  rootProductCount: number;
}

export interface BazisDraftMaterialMapping {
  target_kind: string;
  sheet_material_type_id: number | string | null;
  film_id: number | string | null;
  milling_type_id?: number | string | null;
}

/** Фрезеровка по умолчанию, когда у панели нет свойства «Фрезировка» или оно явно пропущено. */
export const DEFAULT_BAZIS_MILLING_TYPE_ID = 1;
/** Подпись фрезеровки в списке несопоставленного (ошибка BAZIS_UNMAPPED_MATERIALS). */
export const UNMAPPED_MILLING_SUFFIX = ' (фрезеровка)';

export type BazisDraftReferenceKind = 'film' | 'milling';
export type BazisDraftReferenceLookup = ReadonlyMap<string, number>;

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
  doweling: boolean;
}

interface TargetOrderDuplicateRow {
  bazis_node_id: number | string;
  order_detail_id: number | string;
  matched_by: 'node_map' | 'basis_fields';
}

export function clientKeyForNode(bazisNodeId: number): string {
  return `bazis-node-${bazisNodeId}`;
}

// Присадка панели: есть записи отверстий. Зеркало HAS_DRILLING_SQL
// (pg-bazis-repository) и FE parseNodeRaw.holes: контейнер
// «Отверстия»->«Отверстие» + прямой массив «Отверстие».
export function panelHasDrilling(rawJson: Record<string, unknown> | null): boolean {
  if (!rawJson) {
    return false;
  }
  const direct = rawJson['Отверстие'];
  if (Array.isArray(direct) && direct.length > 0) {
    return true;
  }
  const container = rawJson['Отверстия'];
  if (container == null || typeof container !== 'object' || Array.isArray(container)) {
    return false;
  }
  const items = (container as Record<string, unknown>)['Отверстие'];
  return Array.isArray(items) && items.length > 0;
}

// Непустой пользовательский «Маршрут» тоже требует присадки в ERP-заказе,
// даже если Базис не выгрузил отдельные записи отверстий для панели.
export function panelHasRoute(rawJson: Record<string, unknown> | null): boolean {
  return panelUserPropertyValue(rawJson, new Set(['маршрут'])) !== null;
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
    const mapping = mappings.get(`sheet:${normalizeBazisReferenceName(panel.mainMaterialName)}`);
    if (mapping?.target_kind !== 'sheet' || toNullableNumber(mapping.sheet_material_type_id) == null) {
      names.add(panel.mainMaterialName);
    }
  }
  return [...names];
}

// Фрезеровка панели: сопоставление «milling» (выбор пользователя при импорте) →
// фрезеровка ERP с тем же названием → не найдена (undefined). Без свойства или при
// «Пропустить» — фрезеровка по умолчанию.
export function resolvePanelMillingTypeId(
  rawJson: Record<string, unknown> | null,
  mappings: Map<string, BazisDraftMaterialMapping>,
  referenceLookup: BazisDraftReferenceLookup,
): number | undefined {
  const millingName = panelCustomMillingName(rawJson);
  if (!millingName) {
    return DEFAULT_BAZIS_MILLING_TYPE_ID;
  }
  const mapping = mappings.get(`milling:${normalizeBazisReferenceName(millingName)}`);
  if (mapping?.target_kind === 'ignore') {
    return DEFAULT_BAZIS_MILLING_TYPE_ID;
  }
  if (mapping?.target_kind === 'milling') {
    const mapped = toNullableNumber(mapping.milling_type_id);
    if (mapped != null) {
      return mapped;
    }
  }
  return referenceLookup.get(bazisReferenceLookupKey('milling', millingName));
}

// Фрезеровки выбранных панелей, которых нет ни в сопоставлениях, ни в справочнике ERP.
export function collectUnresolvedMillingNames(
  panels: ReadonlyArray<Pick<BazisDraftPanel, 'rawJson'>>,
  mappings: Map<string, BazisDraftMaterialMapping>,
  referenceLookup: BazisDraftReferenceLookup,
): string[] {
  const names = new Map<string, string>();
  for (const panel of panels) {
    if (resolvePanelMillingTypeId(panel.rawJson, mappings, referenceLookup) !== undefined) {
      continue;
    }
    const millingName = panelCustomMillingName(panel.rawJson);
    if (millingName) {
      names.set(normalizeBazisReferenceName(millingName), millingName);
    }
  }
  return [...names.values()];
}

// Всё, что мешает собрать детали ERP: листы без сопоставления и ненайденные фрезеровки.
export function collectUnmappedMaterialNames(
  panels: ReadonlyArray<Pick<BazisDraftPanel, 'mainMaterialName' | 'rawJson'>>,
  mappings: Map<string, BazisDraftMaterialMapping>,
  referenceLookup: BazisDraftReferenceLookup,
): string[] {
  return [
    ...collectUnmappedSheetNames(panels, mappings),
    ...collectUnresolvedMillingNames(panels, mappings, referenceLookup).map(
      (name) => `${name}${UNMAPPED_MILLING_SUFFIX}`,
    ),
  ];
}

export function buildDraftDetails(
  panels: ReadonlyArray<BazisDraftPanel>,
  mappings: Map<string, BazisDraftMaterialMapping>,
  revision: BazisDraftRevision,
  referenceLookup: BazisDraftReferenceLookup = new Map(),
): BazisDraftDetail[] {
  return panels.map((panel) => {
    const filmName = panelPreferredFilmName(panel.rawJson);
    const filmMapping = panelFilmNameCandidates(panel.rawJson)
      .map((name) => mappings.get(`film:${normalizeBazisReferenceName(name)}`))
      .find((mapping) => mapping != null);
    const legacyLookupName = panelLegacyLookupFilmName(panel.rawJson);
    const sheetMapping = panel.mainMaterialName
      ? mappings.get(`sheet:${normalizeBazisReferenceName(panel.mainMaterialName)}`)
      : undefined;
    // Ненайденную фрезеровку команды заказа отбивают раньше (collectUnmappedMaterialNames);
    // здесь — прежний запасной вариант для выгрузки раскроя и старых вызовов.
    const millingTypeId =
      resolvePanelMillingTypeId(panel.rawJson, mappings, referenceLookup) ??
      DEFAULT_BAZIS_MILLING_TYPE_ID;
    const filmId =
      filmMapping == null
        ? (filmName ? referenceLookup.get(bazisReferenceLookupKey('film', filmName)) : undefined)
          ?? (legacyLookupName
            ? referenceLookup.get(bazisReferenceLookupKey('film', legacyLookupName))
            : undefined)
          ?? null
        : filmMapping.target_kind === 'film'
          ? toNullableNumber(filmMapping.film_id)
          : null;

    return {
      bazisNodeId: panel.bazisNodeId,
      clientKey: clientKeyForNode(panel.bazisNodeId),
      detailName: panel.name,
      // Защита для старых ревизий во время rolling deploy: даже до backfill
      // ERP-детали получают те же целые размеры, что и новые XML-импорты.
      height: Math.round(panel.lengthMm ?? 0),
      width: Math.round(panel.widthMm ?? 0),
      quantity: panel.cumulativeQuantity ?? 0,
      sheetMaterialTypeId:
        sheetMapping?.target_kind === 'sheet'
          ? toNullableNumber(sheetMapping.sheet_material_type_id)
          : null,
      millingTypeId,
      edgeTypeId: 1,
      filmId,
      priority: 100,
      basisProject:
        panel.productOrderNo ?? revision.revisionBazisOrderNo ?? revision.bazisProjectName,
      basisProduct:
        revision.rootProductCount > 1
          ? panel.productName?.trim() || null
          : null,
      basisDesignation: panel.designation,
      basisData: `${panel.position ?? ''}/${panel.designation ?? ''}/${panel.name ?? ''}`,
      doweling: panelHasDrilling(panel.rawJson) || panelHasRoute(panel.rawJson),
    };
  });
}

export function bazisReferenceLookupKey(
  kind: BazisDraftReferenceKind,
  value: string,
): string {
  return `${kind}:${normalizeBazisReferenceName(value)}`;
}

// Плёнка из свойств панели: «Пленка», иначе «Пленка (обр)»; если на пласти та же
// плёнка с поставщиком («Экспорт фасадов») — «Название; Поставщик».
export function panelCustomFilmName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return bazisPanelPropertyFilmName(rawJson);
}

export function panelCustomMillingName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return panelUserPropertyValue(rawJson, BAZIS_MILLING_PROPERTY_NAMES);
}

export function panelCustomPaintName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return panelUserPropertyValue(rawJson, new Set(['краска', 'краска (обр)']));
}

export function panelPreferredFilmName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return panelCustomFilmName(rawJson) ?? bazisPanelUniqueFaceFilm(rawJson)?.name ?? null;
}

// Имена плёнки для поиска сохранённого сопоставления: новое (с поставщиком), затем прежнее
// (правило до «Экспорта фасадов») — ранее сохранённый выбор, включая «Пропустить», не теряется.
export function panelFilmNameCandidates(rawJson: Record<string, unknown> | null): string[] {
  const names = new Map<string, string>();
  for (const name of [panelPreferredFilmName(rawJson), bazisPanelLegacyFilmName(rawJson)]) {
    if (name && !names.has(normalizeBazisReferenceName(name))) {
      names.set(normalizeBazisReferenceName(name), name);
    }
  }
  return [...names.values()];
}

// Прежнее имя для прямого поиска в справочнике (до 2026-11-18 искалось только свойство «Пленка»):
// если плёнки «Название; Поставщик» в справочнике нет, а без поставщика — есть, деталь получает её.
export function panelLegacyLookupFilmName(rawJson: Record<string, unknown> | null): string | null {
  return panelUserPropertyValue(rawJson, new Set(['пленка']));
}

// Имя плёнки для прямого поиска в справочнике плёнок (без сопоставления материалов):
// плёнка из свойств, либо единственная плёнка пластей, если в ней указан поставщик
// («Название; Поставщик» — формат справочника ERP). Плёнку пласти без поставщика
// (штатный экспорт Базиса) по-прежнему подставляет только сопоставление материалов.
export function panelLookupFilmName(
  rawJson: Record<string, unknown> | null,
): string | null {
  const custom = panelCustomFilmName(rawJson);
  if (custom) {
    return custom;
  }
  const face = bazisPanelUniqueFaceFilm(rawJson);
  return face?.withVendor ? face.name : null;
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

export function orderDtoToSaveDto(order: OrderDto): SaveOrderDto {
  return {
    header: orderHeaderToSaveHeader(order.header),
    details: order.details.map(orderDetailToSaveDetail),
    payments: order.payments.map(orderPaymentToSavePayment),
    workshops: order.workshops.map(orderWorkshopToSaveWorkshop),
    requirements: order.requirements.map(orderRequirementToSaveRequirement),
    dowelingLinks: order.dowelingLinks.map(orderDowelingLinkToSaveDowelingLink),
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
    version: order.version,
  };
}

function panelUserPropertyValue(
  rawJson: Record<string, unknown> | null,
  acceptedNames: ReadonlySet<string>,
): string | null {
  return bazisUserPropertyValue(rawJson, acceptedNames);
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  return Number(value);
}

function orderHeaderToSaveHeader(header: OrderDto['header']): SaveOrderHeaderDto {
  return {
    orderId: header.orderId,
    projectId: header.projectId ?? null,
    orderName: header.orderName,
    clientId: header.clientId,
    orderDate: header.orderDate,
    priority: header.priority,
    managerId: header.managerId,
    orderStatusId: header.orderStatusId,
    paymentStatusId: header.paymentStatusId,
    productionStatusId: header.productionStatusId,
    productionStatusFromDetailsEnabled: header.productionStatusFromDetailsEnabled,
    plannedCompletionDate: header.plannedCompletionDate,
    completionDate: header.completionDate,
    issueDate: header.issueDate,
    paymentDate: header.paymentDate,
    discount: header.discount,
    surcharge: header.surcharge,
    linkCuttingFile: header.linkCuttingFile,
    linkCuttingImageFile: header.linkCuttingImageFile,
    linkCadFile: header.linkCadFile,
    linkPdfFile: header.linkPdfFile,
    notes: header.notes,
    refKey1c: header.refKey1c,
    materialId: header.materialId,
    sheetMaterialTypeId: header.sheetMaterialTypeId,
    millingTypeId: header.millingTypeId,
    edgeTypeId: header.edgeTypeId,
    filmId: header.filmId,
  };
}

function orderDetailToSaveDetail(detail: OrderDto['details'][number]): SaveOrderDetailDto {
  return {
    id: detail.id,
    detailNumber: detail.detailNumber,
    detailName: detail.detailName,
    height: detail.height,
    width: detail.width,
    quantity: detail.quantity,
    materialId: detail.materialId,
    sheetMaterialTypeId: detail.sheetMaterialTypeId,
    millingTypeId: detail.millingTypeId,
    edgeTypeId: detail.edgeTypeId,
    filmId: detail.filmId,
    area: detail.area,
    millingCostPerSqm: detail.millingCostPerSqm,
    detailCost: detail.detailCost,
    priority: detail.priority,
    productionStatusId: detail.productionStatusId,
    jointOrderId: detail.jointOrderId,
    note: detail.note,
    basisProject: detail.basisProject,
    basisProduct: detail.basisProduct,
    basisData: detail.basisData,
    basisDesignation: detail.basisDesignation,
    doweling: detail.doweling,
    linkCuttingFile: detail.linkCuttingFile,
    linkCuttingImageFile: detail.linkCuttingImageFile,
    linkCadFile: detail.linkCadFile,
    linkPdfFile: detail.linkPdfFile,
    refKey1c: detail.refKey1c,
  };
}

function orderPaymentToSavePayment(payment: OrderDto['payments'][number]): SaveOrderPaymentDto {
  return {
    id: payment.id,
    typePaidId: payment.typePaidId,
    amount: payment.amount,
    paymentDate: payment.paymentDate,
    notes: payment.notes,
    refKey1c: payment.refKey1c,
  };
}

function orderWorkshopToSaveWorkshop(workshop: OrderDto['workshops'][number]): SaveOrderWorkshopDto {
  return {
    id: workshop.id,
    workshopId: workshop.workshopId,
    productionStatusId: workshop.productionStatusId,
    receivedDate: workshop.receivedDate,
    startedDate: workshop.startedDate,
    completedDate: workshop.completedDate,
    plannedCompletionDate: workshop.plannedCompletionDate,
    sequenceOrder: workshop.sequenceOrder,
    responsibleEmployeeId: workshop.responsibleEmployeeId,
    notes: workshop.notes,
    refKey1c: workshop.refKey1c,
  };
}

function orderRequirementToSaveRequirement(
  requirement: OrderDto['requirements'][number],
): SaveOrderRequirementDto {
  return {
    id: requirement.id,
    resourceType: requirement.resourceType,
    materialId: requirement.materialId,
    filmId: requirement.filmId,
    edgeTypeId: requirement.edgeTypeId,
    requiredQuantity: requirement.requiredQuantity,
    unitId: requirement.unitId,
    wastePercentage: requirement.wastePercentage,
    finalQuantity: requirement.finalQuantity,
    requirementStatusId: requirement.requirementStatusId,
    supplierId: requirement.supplierId,
    purchasePrice: requirement.purchasePrice,
    requisitionId: requirement.requisitionId,
    warehouseId: requirement.warehouseId,
    reservedAt: requirement.reservedAt,
    consumedAt: requirement.consumedAt,
    notes: requirement.notes,
    calculationDetails: requirement.calculationDetails,
    refKey1c: requirement.refKey1c,
  };
}

function orderDowelingLinkToSaveDowelingLink(
  dowelingLink: OrderDto['dowelingLinks'][number],
): SaveOrderDowelingLinkDto {
  return {
    id: dowelingLink.id,
    dowelingOrderId: dowelingLink.dowelingOrderId,
    designEngineerId: dowelingLink.designEngineerId,
    refKey1c: dowelingLink.refKey1c,
  };
}
