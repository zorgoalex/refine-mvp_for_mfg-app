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

export function buildDraftDetails(
  panels: ReadonlyArray<BazisDraftPanel>,
  mappings: Map<string, BazisDraftMaterialMapping>,
  revision: BazisDraftRevision,
  referenceLookup: BazisDraftReferenceLookup = new Map(),
): BazisDraftDetail[] {
  return panels.map((panel) => {
    const filmName = panelPreferredFilmName(panel.rawJson);
    const filmMapping = filmName
      ? mappings.get(`film:${normalizeBazisReferenceName(filmName)}`)
      : undefined;
    const sheetMapping = panel.mainMaterialName
      ? mappings.get(`sheet:${normalizeBazisReferenceName(panel.mainMaterialName)}`)
      : undefined;
    const millingName = panelCustomMillingName(panel.rawJson);
    const millingTypeId = millingName
      ? referenceLookup.get(bazisReferenceLookupKey('milling', millingName)) ?? 1
      : 1;
    const filmId =
      filmMapping == null
        ? filmName
          ? referenceLookup.get(bazisReferenceLookupKey('film', filmName)) ?? null
          : null
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
      basisProduct: panel.productName ?? null,
      basisDesignation: panel.designation,
      basisData: `${panel.position ?? ''}/${panel.designation ?? ''}/${panel.name ?? ''}`,
      doweling: panelHasDrilling(panel.rawJson) || panelHasRoute(panel.rawJson),
    };
  });
}

export function normalizeBazisReferenceName(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');
}

export function bazisReferenceLookupKey(
  kind: BazisDraftReferenceKind,
  value: string,
): string {
  return `${kind}:${normalizeBazisReferenceName(value)}`;
}

export function panelCustomFilmName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return panelUserPropertyValue(rawJson, new Set(['пленка']));
}

export function panelCustomMillingName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return panelUserPropertyValue(rawJson, new Set(['фрезировка', 'фрезеровка']));
}

export function panelCustomPaintName(
  rawJson: Record<string, unknown> | null,
): string | null {
  return panelUserPropertyValue(rawJson, new Set(['краска', 'краска (обр)']));
}

export function panelPreferredFilmName(
  rawJson: Record<string, unknown> | null,
): string | null {
  const customFilmName = panelCustomFilmName(rawJson);
  if (customFilmName) {
    return customFilmName;
  }

  const uniqueFilmNames = new Map<string, string>();
  for (const filmName of extractFilmNames(rawJson)) {
    uniqueFilmNames.set(normalizeBazisReferenceName(filmName), filmName);
  }
  return uniqueFilmNames.size === 1 ? [...uniqueFilmNames.values()][0] ?? null : null;
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

function panelUserPropertyValue(
  rawJson: Record<string, unknown> | null,
  acceptedNames: ReadonlySet<string>,
): string | null {
  if (!rawJson) {
    return null;
  }

  const propertyCandidates: unknown[] = [];
  const nested = rawJson['ПользовательскиеСвойства'];
  if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
    propertyCandidates.push((nested as Record<string, unknown>)['Свойство']);
  }
  propertyCandidates.push(rawJson['Свойство']);

  for (const candidate of propertyCandidates) {
    const properties = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
    for (const property of properties) {
      if (typeof property !== 'object' || property === null || Array.isArray(property)) {
        continue;
      }
      const row = property as Record<string, unknown>;
      const propertyName = textValue(row['Имя'] ?? row['Наименование']);
      if (!propertyName || !acceptedNames.has(normalizeBazisReferenceName(propertyName))) {
        continue;
      }
      const propertyValue = textValue(row['Значение']);
      if (propertyValue) {
        return propertyValue;
      }
    }
  }

  return null;
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
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
