import { apiRoutes, backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  BazisAddToOrderRequest,
  BazisAddToOrderResponse,
  BazisNodeNotesResponse,
  BazisRevisionEstimate,
  CreateOrderFromDraftRequest,
  BazisImportResponse,
  BazisNodeCard,
  BazisOrderDraftResponse,
  BazisNodeSearchResponse,
  BazisProjectCard,
  BazisProjectDeleteResponse,
  BazisProjectListItem,
  BazisProjectNameResponse,
  BazisRevisionMaterialsSummary,
  BazisRevisionOrder,
  BazisTreeNode,
  CreateOrderFromRevisionResponse,
  MaterialMapping,
  UpsertMaterialMapping,
} from './types/bazisApi.types';

export interface BazisRevisionCutExportFile {
  blob: Blob;
  fileName: string | null;
}

export const bazisApi = {
  import(
    file: File,
    params: { projectId?: number; bazisProjectId?: number },
  ): Promise<BazisImportResponse> {
    const formData = new FormData();
    formData.append('file', file);
    if (params.projectId != null) formData.append('projectId', String(params.projectId));
    if (params.bazisProjectId != null) {
      formData.append('bazisProjectId', String(params.bazisProjectId));
    }
    return httpClient.post<BazisImportResponse>(apiRoutes.bazis.imports, formData);
  },

  listProjects(projectId?: number): Promise<BazisProjectListItem[]> {
    return httpClient.get<BazisProjectListItem[]>(
      projectId == null
        ? apiRoutes.bazis.projects
        : withQuery(apiRoutes.bazis.projects, { projectId: validateId(projectId, 'projectId') }),
    );
  },

  getProject(id: number): Promise<BazisProjectCard> {
    return httpClient.get<BazisProjectCard>(apiRoutes.bazis.project(validateId(id, 'bazisProjectId')));
  },

  renameProject(id: number, name: string): Promise<BazisProjectNameResponse> {
    return httpClient.patch<BazisProjectNameResponse>(
      apiRoutes.bazis.project(validateId(id, 'bazisProjectId')),
      { name },
    );
  },

  deleteProject(id: number): Promise<BazisProjectDeleteResponse> {
    return httpClient.delete<BazisProjectDeleteResponse>(
      apiRoutes.bazis.project(validateId(id, 'bazisProjectId')),
    );
  },

  getTree(revisionId: number, parentNodeId?: number): Promise<BazisTreeNode[]> {
    const path = apiRoutes.bazis.revisionTree(validateId(revisionId, 'revisionId'));
    return httpClient.get<BazisTreeNode[]>(
      parentNodeId == null ? path : withQuery(path, { parentNodeId: validateId(parentNodeId, 'parentNodeId') }),
    );
  },

  getNodeCard(nodeId: number): Promise<BazisNodeCard> {
    return httpClient.get<BazisNodeCard>(apiRoutes.bazis.node(validateId(nodeId, 'nodeId')));
  },

  setNodeNotes(nodeId: number, notes: string | null): Promise<BazisNodeNotesResponse> {
    return httpClient.patch<BazisNodeNotesResponse>(
      apiRoutes.bazis.nodeNotes(validateId(nodeId, 'nodeId')),
      { notes },
    );
  },

  searchNodes(
    revisionId: number,
    params: { q?: string; objectType?: string; limit?: number },
  ): Promise<BazisNodeSearchResponse> {
    const query: Record<string, string | number> = {};
    if (params.q) query.q = params.q;
    if (params.objectType) query.objectType = params.objectType;
    if (params.limit != null) query.limit = params.limit;
    return httpClient.get<BazisNodeSearchResponse>(
      withQuery(apiRoutes.bazis.revisionNodesSearch(validateId(revisionId, 'revisionId')), query),
    );
  },

  getMaterialsSummary(revisionId: number): Promise<BazisRevisionMaterialsSummary> {
    return httpClient.get<BazisRevisionMaterialsSummary>(
      apiRoutes.bazis.revisionMaterialsSummary(validateId(revisionId, 'revisionId')),
    );
  },

  listRevisionOrders(revisionId: number): Promise<BazisRevisionOrder[]> {
    return httpClient.get<BazisRevisionOrder[]>(
      apiRoutes.bazis.revisionOrders(validateId(revisionId, 'revisionId')),
    );
  },

  getFullTree(revisionId: number): Promise<BazisTreeNode[]> {
    return httpClient.get<BazisTreeNode[]>(
      withQuery(apiRoutes.bazis.revisionTree(validateId(revisionId, 'revisionId')), { all: 'true' }),
    );
  },

  getRevisionEstimate(revisionId: number): Promise<BazisRevisionEstimate> {
    return httpClient.get<BazisRevisionEstimate>(
      apiRoutes.bazis.revisionEstimate(validateId(revisionId, 'revisionId')),
    );
  },

  async exportCutXls(
    revisionId: number,
    selectedNodeIds: number[],
    templateId?: number,
  ): Promise<BazisRevisionCutExportFile> {
    validateNodeSelection(selectedNodeIds);
    const { blob, fileName } = await httpClient.download(
      withQuery(apiRoutes.bazis.revisionCutXls(validateId(revisionId, 'revisionId')), { templateId }),
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ selectedNodeIds }),
      },
    );
    return { blob, fileName };
  },

  listMaterialMappings(names?: string[]): Promise<MaterialMapping[]> {
    const normalizedNames = names?.map((name) => name.trim()).filter(Boolean) ?? [];
    return httpClient.get<MaterialMapping[]>(
      normalizedNames.length === 0
        ? apiRoutes.bazis.materialMappings
        : withQuery(apiRoutes.bazis.materialMappings, { names: normalizedNames.join(',') }),
    );
  },

  upsertMaterialMappings(items: UpsertMaterialMapping[]): Promise<MaterialMapping[]> {
    return httpClient.put<MaterialMapping[]>(apiRoutes.bazis.materialMappings, { items });
  },

  createOrder(
    revisionId: number,
    body: {
      clientId: number;
      orderName: string;
      orderStatusId: number;
      selectedNodeIds: number[];
      idempotencyKey: string;
    },
  ): Promise<CreateOrderFromRevisionResponse> {
    return httpClient.post<CreateOrderFromRevisionResponse>(
      apiRoutes.bazis.createOrder(validateId(revisionId, 'revisionId')),
      body,
    );
  },

  createOrderFromDraft(
    revisionId: number,
    body: CreateOrderFromDraftRequest,
  ): Promise<CreateOrderFromRevisionResponse> {
    return httpClient.post<CreateOrderFromRevisionResponse>(
      apiRoutes.bazis.revisionOrders(validateId(revisionId, 'revisionId')),
      body,
    );
  },

  addToOrder(
    revisionId: number,
    body: BazisAddToOrderRequest,
  ): Promise<BazisAddToOrderResponse> {
    return httpClient.post<BazisAddToOrderResponse>(
      backendApiPath(`/bazis/revisions/${validateId(revisionId, 'revisionId')}/add-to-order`),
      body,
    );
  },

  orderDraft(
    revisionId: number,
    body: {
      selectedNodeIds: number[];
      targetOrderId?: number | null;
    },
  ): Promise<BazisOrderDraftResponse> {
    return httpClient.post<BazisOrderDraftResponse>(
      backendApiPath(`/bazis/revisions/${validateId(revisionId, 'revisionId')}/order-draft`),
      body,
    );
  },
};

function validateId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }

  return value;
}

function validateNodeSelection(selectedNodeIds: number[]): void {
  if (!Array.isArray(selectedNodeIds) || selectedNodeIds.length < 1 || selectedNodeIds.length > 500) {
    throw new Error('Invalid selectedNodeIds');
  }
  selectedNodeIds.forEach((nodeId) => validateId(nodeId, 'nodeId'));
}
