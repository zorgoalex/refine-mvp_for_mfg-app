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
  totalAreaM2: number;
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

export interface BazisCutDeleteSetResultDto {
  deleted: true;
  set: BazisCutSetListItemDto;
}

export interface CreateBazisCutSetRequest {
  orderId: number;
  detailIds: number[];
}

export interface BazisCutPickerCriteria {
  dateFrom: string;
  dateTo: string;
  orderIds: number[];
  clientIds: number[];
  sheetMaterialTypeIds: number[];
  millingTypeIds: number[];
  bazisKeys: string[];
  designEngineerIds: number[];
  dowelingOrderIds: number[];
  excludedDetailIds: number[];
}

export interface BazisCutPickerOption {
  id: number;
  label: string;
}

export interface BazisCutPickerBazisOption {
  key: string;
  label: string;
  type: 'project' | 'order' | 'legacy';
}

export interface BazisCutPickerFacets {
  orders: BazisCutPickerOption[];
  clients: BazisCutPickerOption[];
  sheetMaterials: BazisCutPickerOption[];
  millingTypes: BazisCutPickerOption[];
  bazisSources: BazisCutPickerBazisOption[];
  designEngineers: BazisCutPickerOption[];
  dowelingOrders: BazisCutPickerOption[];
}

export interface BazisCutPickerDetail {
  detailId: number;
  orderId: number;
  orderNumber: string;
  orderDate: string;
  clientName: string;
  detailNumber: number;
  detailName: string;
  quantity: number;
  heightMm: number;
  widthMm: number;
  areaM2: number;
  materialName: string;
  millingName: string;
  bazisLabel: string;
  designEngineerName: string;
  dowelingOrderName: string;
  bazisCutSets: Array<{ bazisCutSetId: number; name: string }>;
  selectionToken: string;
}

export interface BazisCutPickerSearchRequest extends BazisCutPickerCriteria {
  page: number;
  pageSize: number;
}

export interface BazisCutPickerSearchResponse {
  items: BazisCutPickerDetail[];
  page: number;
  pageSize: number;
  total: number;
  totalQuantity: number;
  totalAreaM2: number;
  criteriaHash: string;
}

export interface CreateBazisCutSetFromPickerRequest {
  criteria: BazisCutPickerCriteria;
  criteriaHash: string;
  details: Array<{ detailId: number; selectionToken: string }>;
}

export interface BazisCutOrderMembershipsResponse {
  orderId: number;
  details: Array<{
    detailId: number;
    bazisCutSets: Array<{ bazisCutSetId: number; name: string }>;
  }>;
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

export interface RemoveBazisCutSetRequest {
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
  pickerFacets: `${BAZIS_CUT_SETS_ROOT}/picker/facets`,
  pickerSearch: `${BAZIS_CUT_SETS_ROOT}/picker/search`,
  fromPicker: `${BAZIS_CUT_SETS_ROOT}/from-picker`,
  orderMemberships: `${BAZIS_CUT_SETS_ROOT}/order-memberships`,
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

  listPickerFacets(period: Pick<BazisCutPickerCriteria, 'dateFrom' | 'dateTo'>): Promise<BazisCutPickerFacets> {
    validatePickerPeriod(period.dateFrom, period.dateTo);
    const params = new URLSearchParams({ dateFrom: period.dateFrom, dateTo: period.dateTo });
    return httpClient.get<BazisCutPickerFacets>(`${bazisCutSetRoutes.pickerFacets}?${params}`);
  },

  searchPicker(request: BazisCutPickerSearchRequest): Promise<BazisCutPickerSearchResponse> {
    validatePickerCriteria(request);
    validatePageValue(request.page, 'page');
    if (!Number.isInteger(request.pageSize) || request.pageSize < 1 || request.pageSize > 100) {
      throw new Error('Invalid pageSize');
    }
    return httpClient.post<BazisCutPickerSearchResponse>(bazisCutSetRoutes.pickerSearch, request);
  },

  createFromPicker(
    request: CreateBazisCutSetFromPickerRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutMutationResultDto> {
    validatePickerCriteria(request.criteria);
    if (!/^[a-f0-9]{64}$/.test(request.criteriaHash)
      || request.details.length < 1 || request.details.length > 500
      || request.details.some((detail) => !Number.isInteger(detail.detailId) || detail.detailId < 1
        || !/^[a-f0-9]{64}$/.test(detail.selectionToken))) {
      throw new Error('Invalid picker selection');
    }
    return httpClient.post<BazisCutMutationResultDto>(
      bazisCutSetRoutes.fromPicker,
      request,
      commandOptions(options),
    );
  },

  orderMemberships(orderId: number): Promise<BazisCutOrderMembershipsResponse> {
    const params = new URLSearchParams({ orderId: String(validateId(orderId, 'orderId')) });
    return httpClient.get<BazisCutOrderMembershipsResponse>(`${bazisCutSetRoutes.orderMemberships}?${params}`);
  },

  get(setId: number): Promise<BazisCutSetCardDto> {
    return httpClient.get<BazisCutSetCardDto>(bazisCutSetRoutes.byId(setId));
  },

  removeSet(
    setId: number,
    request: RemoveBazisCutSetRequest,
    options: BazisCutCommandOptions,
  ): Promise<BazisCutDeleteSetResultDto> {
    return httpClient.delete<BazisCutDeleteSetResultDto>(bazisCutSetRoutes.byId(setId), {
      ...commandOptions(options),
      body: JSON.stringify(request),
    });
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

function validatePickerCriteria(criteria: BazisCutPickerCriteria): void {
  validatePickerPeriod(criteria.dateFrom, criteria.dateTo);
  const idArrays = [criteria.orderIds, criteria.clientIds, criteria.sheetMaterialTypeIds,
    criteria.millingTypeIds, criteria.designEngineerIds, criteria.dowelingOrderIds];
  if (idArrays.some((values) => !Array.isArray(values) || values.length > 500
    || values.some((value) => !Number.isInteger(value) || value < 1))
    || !Array.isArray(criteria.bazisKeys) || criteria.bazisKeys.length > 500
    || criteria.bazisKeys.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200)
    || !Array.isArray(criteria.excludedDetailIds) || criteria.excludedDetailIds.length > 2000
    || criteria.excludedDetailIds.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error('Invalid picker criteria');
  }
}

function validatePickerPeriod(dateFrom: string, dateTo: string): void {
  const from = parseDateOnly(dateFrom);
  const to = parseDateOnly(dateTo);
  if (from === null || to === null || from > to || Math.floor((to - from) / 86_400_000) + 1 > 366) {
    throw new Error('Invalid picker period');
  }
}

function parseDateOnly(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp : null;
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
