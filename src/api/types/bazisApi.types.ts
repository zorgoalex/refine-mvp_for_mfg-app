import type { SaveOrderDto } from './orderApi.types';

export interface BazisImportResponse {
  bazisProject: {
    bazisProjectId: number;
    projectId: number;
    name: string;
  };
  revision: {
    bazisRevisionId: number;
    revisionNo: number;
    xmlSha256: string;
    summary: Record<string, number>;
  };
  unmappedMaterials: Array<{
    name: string;
    kindGuess: string;
    usageCount: number;
  }>;
  warnings: string[];
  requestId: string;
}

export interface BazisOrderRef {
  orderId: number;
  orderName: string;
  orderDeleted?: boolean;
}

export interface BazisProjectListItem {
  bazisProjectId: number;
  projectId: number;
  /** May be absent during a mixed frontend/backend rollout. */
  projectName?: string | null;
  name: string;
  revisionsCount: number;
  lastRevisionNo: number | null;
  lastImportedAt: string | null;
  bazisOrderNo: string | null;
  linkedOrderIds: number[];
  linkedOrders: BazisOrderRef[];
}

export interface BazisProjectNameResponse {
  bazisProjectId: number;
  projectId: number;
  name: string;
}

export interface BazisProjectDeleteResponse {
  bazisProjectId: number;
  projectId: number;
  name: string;
  revisionsDeleted: number;
  nodesDeleted: number;
}

export interface BazisProjectCard extends BazisProjectListItem {
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

export interface BazisTreeNode {
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
  /** Число кромок (derived, read-only). Старый backend не отдаёт — коэрсить `?? 0`. */
  edgeCount: number;
  /** Присадка: есть отверстия (derived, read-only). Коэрсить `?? false`. */
  hasDrilling: boolean;
  /** Пользовательское свойство «Фрезировка»/«Фрезеровка». Коэрсить `?? null`. */
  millingName?: string | null;
  /** Пользовательское свойство «Пленка»/«Плёнка». Коэрсить `?? null`. */
  filmName?: string | null;
  /** Примечание оператора. Коэрсить `?? null`. */
  notes: string | null;
  childrenCount: number;
  /** ERP-заказы, в которые узел добавлен созданной деталью (с названиями). */
  orders: BazisOrderRef[];
  /** Производное от orders; rollout-совместимость. */
  orderIds: number[];
}

export interface BazisNodeOrderLink {
  orderId: number;
  orderDetailId: number | null;
  mappingKind: string;
  orderDeleted?: boolean;
}

export interface BazisNodeCard {
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
  notes: string | null;
  childrenCount: number;
  rawJson: Record<string, unknown>;
  orderLinks: BazisNodeOrderLink[];
}

export interface BazisNodeNotesResponse {
  bazisNodeId: number;
  notes: string | null;
}

export interface BazisNodeSearchItem {
  bazisNodeId: number;
  nodeKind: string;
  objectType: string | null;
  name: string | null;
  position: string | null;
  designation: string | null;
  mainMaterialName: string | null;
  pathNodeIds: number[];
  pathTitles: Array<string | null>;
}

export interface BazisNodeSearchResponse {
  items: BazisNodeSearchItem[];
  totalMatched: number;
}

export interface BazisPanelsMaterialSummary {
  materialName: string | null;
  panelCount: number;
  totalQuantity: number;
  totalAreaM2: number;
  mappingTargetKind: string | null;
  sheetMaterialTypeId: number | null;
  sheetMaterialTypeName: string | null;
}

export interface BazisHardwareSummary {
  name: string | null;
  totalQuantity: number;
}

export interface BazisRawMaterialUsage {
  name: string;
  usageCount: number;
  totalLengthMm: number | null;
}

export interface BazisRevisionMaterialsSummary {
  summary: Record<string, number>;
  panelsByMaterial: BazisPanelsMaterialSummary[];
  hardwareByName: BazisHardwareSummary[];
  edgesByName: BazisRawMaterialUsage[];
  filmsByName: BazisRawMaterialUsage[];
}

export interface BazisRevisionOrder {
  orderId: number;
  orderName: string | null;
  orderDeleted?: boolean;
  createdAt: string;
  nodesMapped: number;
  detailsCreated: number;
}

export interface MaterialMapping {
  bazisMaterialMappingId: number;
  sourceKind: string;
  bazisName: string;
  targetKind: string;
  sheetMaterialTypeId: number | null;
  filmId: number | null;
  edgeTypeId: number | null;
}

export interface UpsertMaterialMapping {
  sourceKind: 'sheet' | 'film' | 'edge';
  bazisName: string;
  targetKind: 'sheet' | 'film' | 'edge' | 'ignore';
  sheetMaterialTypeId?: number | null;
  filmId?: number | null;
  edgeTypeId?: number | null;
}

export interface CreateOrderFromRevisionResponse {
  orderId: number;
  orderName: string;
  detailsCreated: number;
  mappedNodes: number;
  requestId: string;
  auditId?: string;
}

export interface CreateOrderFromDraftNode {
  clientKey: string;
  bazisNodeId: number;
}

export interface CreateOrderFromDraftRequest {
  order: SaveOrderDto;
  nodes: CreateOrderFromDraftNode[];
  idempotencyKey: string;
}

export interface BazisAddToOrderPair {
  bazisNodeId: number;
  orderDetailId: number;
}

export interface BazisAddToOrderRequest {
  orderId: number;
  adds: number[];
  replaces: BazisAddToOrderPair[];
  skips: BazisAddToOrderPair[];
  idempotencyKey: string;
}

export interface BazisAddToOrderResponse {
  orderId: number;
  detailsAdded: number;
  detailsReplaced: number;
  requestId: string;
}

export interface BazisOrderDraftDetail {
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

export interface BazisOrderDraftDuplicate {
  bazisNodeId: number;
  orderDetailId: number;
  matchedBy: 'node_map' | 'basis_fields';
}

export interface BazisOrderDraftResponse {
  revisionId: number;
  projectId: number;
  clientId: number | null;
  clientName: string | null;
  bazisProjectName: string;
  bazisOrderNo: string | null;
  details: BazisOrderDraftDetail[];
  duplicates: BazisOrderDraftDuplicate[];
}

export interface BazisEstimateMaterial {
  nodeId: number;
  source: 'main' | 'related';
  nodeName: string | null;
  nodeObjectType: string | null;
  nodeCode: string | null;
  materialId: string | null;
  code: string | null;
  name: string;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
}

export interface BazisEstimateOperation {
  nodeId: number;
  nodeName: string | null;
  name: string;
  code: string | null;
  unit: string | null;
  quantity: number | null;
  price: number | null;
  total: number | null;
}

export interface BazisRevisionEstimate {
  materials: BazisEstimateMaterial[];
  operations: BazisEstimateOperation[];
}
