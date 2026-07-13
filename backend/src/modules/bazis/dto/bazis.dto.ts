import type { SaveOrderDto } from '../../orders/dto/save-order.dto';

export interface BazisImportResponseDto {
  bazisProject: { bazisProjectId: number; projectId: number; name: string };
  revision: {
    bazisRevisionId: number;
    revisionNo: number;
    xmlSha256: string;
    summary: Record<string, number>;
  };
  unmappedMaterials: Array<{ name: string; kindGuess: string; usageCount: number }>;
  warnings: string[];
  requestId: string;
}

export interface BazisProjectListItemDto {
  bazisProjectId: number;
  projectId: number;
  name: string;
  revisionsCount: number;
  lastRevisionNo: number | null;
  lastImportedAt: string | null;
  bazisOrderNo: string | null;
  linkedOrderIds: number[];
  linkedOrders: BazisOrderRefDto[];
}

export interface BazisProjectCardDto extends BazisProjectListItemDto {
  revisions: Array<{
    bazisRevisionId: number;
    revisionNo: number;
    fileName: string | null;
    fileSize: number | null;
    xmlSha256: string;
    productName: string | null;
    productPrice: number | null;
    summary: Record<string, number>;
    importedAt: string;
  }>;
}

export interface BazisTreeNodeDto {
  bazisNodeId: number;
  parentNodeId: number | null;
  seq: number;
  nodeKind: string;
  objectType: string | null;
  name: string | null;
  detailCode: string | null;
  position: string | null;
  designation: string | null;
  productOrderNo: string | null;
  quantity: number | null;
  cumulativeQuantity: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  mainMaterialName: string | null;
  childrenCount: number;
  /** ERP-заказы, в которые узел добавлен реально созданной деталью (с названиями). */
  orders: BazisOrderRefDto[];
  /** Производное от orders; сохранено для rollout-совместимости. */
  orderIds: number[];
}

export interface BazisOrderRefDto {
  orderId: number;
  orderName: string;
}

export interface BazisNodeOrderLinkDto {
  orderId: number;
  orderDetailId: number | null;
  mappingKind: string;
}

export interface BazisNodeCardDto {
  bazisNodeId: number;
  revisionId: number;
  bazisProjectId: number;
  projectId: number;
  revisionNo: number;
  parentNodeId: number | null;
  seq: number;
  nodeKind: string;
  objectType: string | null;
  name: string | null;
  detailCode: string | null;
  position: string | null;
  designation: string | null;
  quantity: number | null;
  cumulativeQuantity: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  thicknessMm: number | null;
  price: number | null;
  isRectangular: boolean | null;
  textureOrientation: string | null;
  mainMaterialName: string | null;
  childrenCount: number;
  rawJson: Record<string, unknown>;
  orderLinks: BazisNodeOrderLinkDto[];
}

export interface BazisNodeSearchItemDto {
  bazisNodeId: number;
  nodeKind: string;
  objectType: string | null;
  name: string | null;
  position: string | null;
  designation: string | null;
  mainMaterialName: string | null;
  /** id предков от корня к родителю (без самого узла) — для раскрытия дерева */
  pathNodeIds: number[];
  /** имена предков в том же порядке (для подписи результата) */
  pathTitles: Array<string | null>;
}

export interface BazisNodeSearchResponseDto {
  items: BazisNodeSearchItemDto[];
  totalMatched: number;
}

export interface BazisPanelsMaterialSummaryDto {
  materialName: string | null;
  panelCount: number;
  totalQuantity: number;
  totalAreaM2: number;
  mappingTargetKind: string | null;
  sheetMaterialTypeId: number | null;
  /** Название сматченного ERP-листового материала */
  sheetMaterialTypeName: string | null;
}

export interface BazisHardwareSummaryDto {
  name: string | null;
  totalQuantity: number;
}

export interface BazisRawMaterialUsageDto {
  name: string;
  usageCount: number;
  /** Суммарная длина (мм) — заполняется для кромок */
  totalLengthMm: number | null;
}

export interface BazisRevisionMaterialsSummaryDto {
  summary: Record<string, number>;
  panelsByMaterial: BazisPanelsMaterialSummaryDto[];
  hardwareByName: BazisHardwareSummaryDto[];
  edgesByName: BazisRawMaterialUsageDto[];
  filmsByName: BazisRawMaterialUsageDto[];
}

export interface BazisEstimateMaterialDto {
  /** Узел-владелец материала */
  nodeId: number;
  /** main = ОсновнойМатериал, related = СопутствующийМатериал (кромки и т.п.) */
  source: 'main' | 'related';
  nodeName: string | null;
  nodeObjectType: string | null;
  /** Код на самом узле (у фурнитуры — артикул позиции) */
  nodeCode: string | null;
  /** ID материала из Базиса (ОсновнойМатериал.ID) */
  materialId: string | null;
  code: string | null;
  name: string;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
}

export interface BazisEstimateOperationDto {
  /** Узел (панель), к которому привязана операция */
  nodeId: number;
  nodeName: string | null;
  name: string;
  code: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
}

export interface BazisRevisionEstimateDto {
  materials: BazisEstimateMaterialDto[];
  operations: BazisEstimateOperationDto[];
}

export interface BazisRevisionOrderDto {
  orderId: number;
  orderName: string | null;
  createdAt: string;
  nodesMapped: number;
  detailsCreated: number;
}

export interface MaterialMappingDto {
  bazisMaterialMappingId: number;
  sourceKind: string;
  bazisName: string;
  targetKind: string;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  edgeTypeId: number | null;
}

export interface UpsertMaterialMappingDto {
  sourceKind: 'sheet' | 'film' | 'edge';
  bazisName: string;
  targetKind: 'sheet' | 'film' | 'edge' | 'ignore';
  sheetMaterialTypeId?: number | null;
  filmId?: number | null;
  edgeTypeId?: number | null;
}

export interface CreateOrderFromRevisionResponseDto {
  orderId: number;
  orderName: string;
  detailsCreated: number;
  mappedNodes: number;
  requestId: string;
  auditId?: string;
}

export interface BazisAddToOrderPairDto {
  bazisNodeId: number;
  orderDetailId: number;
}

export interface BazisAddToOrderRequestDto {
  orderId: number;
  adds: number[];
  replaces: BazisAddToOrderPairDto[];
  skips: BazisAddToOrderPairDto[];
  idempotencyKey: string;
}

export interface BazisAddToOrderResponseDto {
  orderId: number;
  detailsAdded: number;
  detailsReplaced: number;
  requestId: string;
}

export interface CreateOrderFromDraftNodeDto {
  clientKey: string;
  bazisNodeId: number;
}

export interface CreateOrderFromDraftRequestDto {
  order: SaveOrderDto;
  nodes: CreateOrderFromDraftNodeDto[];
  idempotencyKey: string;
}

export interface BazisOrderDraftDetailDto {
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

export interface BazisOrderDraftDuplicateDto {
  bazisNodeId: number;
  orderDetailId: number;
  matchedBy: 'node_map' | 'basis_fields';
}

export interface BazisOrderDraftResponseDto {
  revisionId: number;
  projectId: number;
  clientId: number | null;
  clientName: string | null;
  bazisProjectName: string;
  bazisOrderNo: string | null;
  details: BazisOrderDraftDetailDto[];
  duplicates: BazisOrderDraftDuplicateDto[];
}

export interface BazisProjectDeleteResponseDto {
  bazisProjectId: number;
  projectId: number;
  name: string;
  revisionsDeleted: number;
  nodesDeleted: number;
}
