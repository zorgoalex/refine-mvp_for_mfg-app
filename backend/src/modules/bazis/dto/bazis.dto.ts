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
  linkedOrderIds: number[];
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
  quantity: number | null;
  cumulativeQuantity: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  mainMaterialName: string | null;
  childrenCount: number;
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
}

export interface BazisHardwareSummaryDto {
  name: string | null;
  totalQuantity: number;
}

export interface BazisRawMaterialUsageDto {
  name: string;
  usageCount: number;
}

export interface BazisRevisionMaterialsSummaryDto {
  summary: Record<string, number>;
  panelsByMaterial: BazisPanelsMaterialSummaryDto[];
  hardwareByName: BazisHardwareSummaryDto[];
  edgesByName: BazisRawMaterialUsageDto[];
  filmsByName: BazisRawMaterialUsageDto[];
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
