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

export interface BazisProjectListItem {
  bazisProjectId: number;
  projectId: number;
  name: string;
  revisionsCount: number;
  lastRevisionNo: number | null;
  lastImportedAt: string | null;
  linkedOrderIds: number[];
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
  quantity: number | null;
  cumulativeQuantity: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  thicknessMm: number | null;
  mainMaterialName: string | null;
  childrenCount: number;
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
