import { backendApiPath } from './apiRoutes';
import { httpClient } from './httpClient';

export interface BazisCutSetListQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface BazisCutSourceRefDto {
  id: number;
  label: string;
  deleted?: boolean;
}

export interface BazisCutSetListItemDto {
  bazisCutSetId: number;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  quantity: number;
  positionCount: number;
  orders: BazisCutSourceRefDto[];
  projects: BazisCutSourceRefDto[];
  bazisProjects: BazisCutSourceRefDto[];
  bazisOrders: BazisCutSourceRefDto[];
}

export interface BazisCutSetListResponse {
  items: BazisCutSetListItemDto[];
  page: number;
  pageSize: number;
  total: number;
}

/** The 33 editable Basis fields; frozen provenance is carried separately. */
export interface BazisCutDetailFields {
  cutEnabled: boolean;
  materialType: string;
  materialName: string;
  materialArticle: string;
  thicknessMm: number;
  position: string;
  partName: string;
  finishedLengthMm: number;
  finishedWidthMm: number;
  cutLengthMm: number;
  cutWidthMm: number;
  quantity: number;
  orientation: string;
  groove: string;
  l1Name: string;
  l1Designation: string;
  l1ThicknessMm: number;
  l2Name: string;
  l2Designation: string;
  l2ThicknessMm: number;
  w1Name: string;
  w1Designation: string;
  w1ThicknessMm: number;
  w2Name: string;
  w2Designation: string;
  w2ThicknessMm: number;
  priority: number | null;
  comment: string;
  customProperty: string;
  glue: string;
  milling: string;
  route: string;
  film: string;
}

export interface BazisCutSetDetailDto extends BazisCutDetailFields {
  bazisCutSetDetailId: number;
  bazisCutSetId: number;
  sortOrder: number;
  sourceOrderDetailId: number | null;
  sourceOrderId: number | null;
  sourceOrderDeleted?: boolean;
  sourceProjectId: number | null;
  sourceBazisProjectId: number | null;
  sourceBazisRevisionId: number | null;
  sourceBazisNodeId: number | null;
  sourceOrderName: string;
  sourceOrderFullNumber: string;
  sourceProjectCode: string;
  sourceBazisProjectName: string;
  sourceBazisOrderNo: string;
  sourceBazisProductName: string;
  sourceBathCutNumber: string;
  createdAt: string;
  updatedAt: string;
}

export interface BazisCutSetCardDto extends BazisCutSetListItemDto {
  createdBy: number | null;
  updatedBy: number | null;
  details: BazisCutSetDetailDto[];
}

export interface BazisCutMutationResultDto {
  set: BazisCutSetCardDto;
  /** Present on create/add responses; duplicate-only add returns zero. */
  addedCount?: number;
}

export interface CreateBazisCutSetRequest {
  orderId: number;
  detailIds: number[];
}

export interface RenameBazisCutSetRequest {
  name: string;
  expectedVersion: number;
}

export interface AddBazisCutSetDetailsRequest {
  orderId: number;
  detailIds: number[];
  expectedVersion: number;
}

export type UpdateBazisCutSetDetailRequest = BazisCutDetailFields & {
  expectedVersion: number;
};

export interface RemoveBazisCutSetDetailRequest {
  expectedVersion: number;
}

export interface BazisCutCommandOptions {
  idempotencyKey: string;
}

export interface BazisCutExportFile {
  blob: Blob;
  fileName: string | null;
}

const BAZIS_CUT_SETS_ROOT = backendApiPath('/bazis-cut-sets');

export const bazisCutSetRoutes = {
  list: BAZIS_CUT_SETS_ROOT,
  byId: (setId: number) => `${BAZIS_CUT_SETS_ROOT}/${validateId(setId, 'setId')}`,
  details: (setId: number) => `${bazisCutSetRoutes.byId(setId)}/details`,
  detail: (setId: number, detailId: number) =>
    `${bazisCutSetRoutes.details(setId)}/${validateId(detailId, 'detailId')}`,
  exportXls: (setId: number) => `${bazisCutSetRoutes.byId(setId)}/export.xls`,
} as const;

/** Backend-owned client for all eight Bazis-cut set routes. */
export const bazisCutApi = {
  list(query: BazisCutSetListQuery = {}): Promise<BazisCutSetListResponse> {
    return httpClient.get<BazisCutSetListResponse>(buildBazisCutSetListUrl(query));
  },

  create(
    request: CreateBazisCutSetRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutMutationResultDto> {
    validateOrderAndDetailIds(request.orderId, request.detailIds);
    return httpClient.post<BazisCutMutationResultDto>(
      bazisCutSetRoutes.list,
      request,
      commandOptions(options),
    );
  },

  get(setId: number): Promise<BazisCutSetCardDto> {
    return httpClient.get<BazisCutSetCardDto>(bazisCutSetRoutes.byId(setId));
  },

  rename(
    setId: number,
    request: RenameBazisCutSetRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutMutationResultDto> {
    return httpClient.patch<BazisCutMutationResultDto>(
      bazisCutSetRoutes.byId(setId),
      request,
      commandOptions(options),
    );
  },

  addDetails(
    setId: number,
    request: AddBazisCutSetDetailsRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutMutationResultDto> {
    validateOrderAndDetailIds(request.orderId, request.detailIds);
    return httpClient.post<BazisCutMutationResultDto>(
      bazisCutSetRoutes.details(setId),
      request,
      commandOptions(options),
    );
  },

  updateDetail(
    setId: number,
    detailId: number,
    request: UpdateBazisCutSetDetailRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutMutationResultDto> {
    return httpClient.patch<BazisCutMutationResultDto>(
      bazisCutSetRoutes.detail(setId, detailId),
      request,
      commandOptions(options),
    );
  },

  removeDetail(
    setId: number,
    detailId: number,
    request: RemoveBazisCutSetDetailRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutMutationResultDto> {
    return httpClient.delete<BazisCutMutationResultDto>(bazisCutSetRoutes.detail(setId, detailId), {
      ...commandOptions(options),
      body: JSON.stringify(request),
    });
  },

  async exportXls(setId: number, templateId?: number): Promise<BazisCutExportFile> {
    const url = templateId ? `${bazisCutSetRoutes.exportXls(setId)}?templateId=${validateId(templateId, 'templateId')}` : bazisCutSetRoutes.exportXls(setId);
    const { blob, fileName } = await httpClient.download(url, {
      method: 'POST',
      cache: 'no-store',
    });
    return { blob, fileName };
  },
};

export function buildBazisCutSetListUrl(query: BazisCutSetListQuery = {}): string {
  const params = new URLSearchParams();
  const search = query.search?.trim();
  if (search) params.set('search', search);
  if (query.page !== undefined) params.set('page', String(validatePageValue(query.page, 'page')));
  if (query.pageSize !== undefined) {
    params.set('pageSize', String(validatePageValue(query.pageSize, 'pageSize')));
  }
  const value = params.toString();
  return value ? `${bazisCutSetRoutes.list}?${value}` : bazisCutSetRoutes.list;
}

function commandOptions(options: BazisCutCommandOptions): RequestInit {
  const key = options.idempotencyKey;
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new Error('Invalid idempotencyKey');
  }
  return { headers: { 'Idempotency-Key': key } };
}

function validateOrderAndDetailIds(orderId: number, detailIds: number[]): void {
  validateId(orderId, 'orderId');
  if (!Array.isArray(detailIds) || detailIds.length < 1 || detailIds.length > 500) {
    throw new Error('Invalid detailIds');
  }
  detailIds.forEach((detailId) => validateId(detailId, 'detailId'));
}

function validatePageValue(value: number, field: string): number {
  return validateId(value, field);
}

function validateId(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}
