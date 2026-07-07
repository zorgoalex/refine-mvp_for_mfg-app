import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import { withQuery } from './ordersApi';
import type {
  BazisImportResponse,
  BazisProjectCard,
  BazisProjectListItem,
  BazisTreeNode,
  CreateOrderFromRevisionResponse,
  MaterialMapping,
  UpsertMaterialMapping,
} from './types/bazisApi.types';

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

  getTree(revisionId: number, parentNodeId?: number): Promise<BazisTreeNode[]> {
    const path = apiRoutes.bazis.revisionTree(validateId(revisionId, 'revisionId'));
    return httpClient.get<BazisTreeNode[]>(
      parentNodeId == null ? path : withQuery(path, { parentNodeId: validateId(parentNodeId, 'parentNodeId') }),
    );
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
};

function validateId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }

  return value;
}
