import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  AddCutItemsRequest,
  CreateCutJobRequest,
  CutFilmOption,
  CutDetailLastReadyResponse,
  CutDetailPlacements,
  CutJobDto,
  CutResultDto,
  CutResultSummary,
  CutSelectionCriteria,
  CutSheetTypeOption,
  EligibleDetailsResponse,
  SaveManualLayoutRequest,
} from './types/cutApi.types';

/**
 * Backend-owned cut-jobs command/read client (CLAUDE.md principle 2/3): every
 * read and write goes through `/api/v1/cut-jobs`; the /cut page never writes to
 * Hasura. Auth token is auto-attached by httpClient.
 */
export const cutApi = {
  list(): Promise<CutJobDto[]> {
    return httpClient.get<CutJobDto[]>(apiRoutes.cutJobs.list);
  },

  async get(cutJobId: number): Promise<CutJobDto> {
    return httpClient.get<CutJobDto>(apiRoutes.cutJobs.byId(validateCutJobId(cutJobId)));
  },

  async listResults(cutJobId: number): Promise<CutResultSummary[]> {
    return httpClient.get<CutResultSummary[]>(apiRoutes.cutJobs.results(validateCutJobId(cutJobId)));
  },

  async getResult(cutJobId: number, resultNo: number): Promise<CutResultDto> {
    return httpClient.get<CutResultDto>(
      apiRoutes.cutJobs.result(validateCutJobId(cutJobId), validateCutJobId(resultNo)),
    );
  },

  create(request: CreateCutJobRequest): Promise<CutJobDto> {
    return httpClient.post<CutJobDto>(apiRoutes.cutJobs.list, request);
  },

  async addItems(cutJobId: number, request: AddCutItemsRequest): Promise<CutJobDto> {
    return httpClient.post<CutJobDto>(apiRoutes.cutJobs.items(validateCutJobId(cutJobId)), request);
  },

  async removeItem(cutJobId: number, itemId: number, version: number): Promise<CutJobDto> {
    return httpClient.delete<CutJobDto>(
      apiRoutes.cutJobs.item(validateCutJobId(cutJobId), validateCutJobId(itemId)),
      { body: JSON.stringify({ version }), headers: { 'Content-Type': 'application/json' } },
    );
  },

  async calculate(cutJobId: number, version: number, commandId: string): Promise<CutJobDto> {
    return httpClient.post<CutJobDto>(apiRoutes.cutJobs.calculate(validateCutJobId(cutJobId)), {
      version,
      commandId,
    });
  },

  async archive(cutJobId: number, version: number): Promise<CutJobDto> {
    return httpClient.delete<CutJobDto>(apiRoutes.cutJobs.byId(validateCutJobId(cutJobId)), {
      body: JSON.stringify({ version }),
      headers: { 'Content-Type': 'application/json' },
    });
  },

  /**
   * Variant B Task 11: list active sheet types for the /cut filter.
   * Gated on cut.view only — no sheet_materials.view required.
   * Sources from GET /api/v1/cut-jobs/sheet-types (not catalog API, not Hasura).
   */
  listSheetTypes(): Promise<CutSheetTypeOption[]> {
    return httpClient.get<CutSheetTypeOption[]>(apiRoutes.cutJobs.sheetTypes);
  },

  listFilmOptions(criteria: CutSelectionCriteria): Promise<CutFilmOption[]> {
    const query = buildEligibleQuery(criteria);
    const path = apiRoutes.cutJobs.filmOptions;
    return httpClient.get<CutFilmOption[]>(query ? `${path}?${query}` : path);
  },

  /**
   * Where the given details/orders are already placed (informational, non-exclusive).
   * Pass detailIds (detail-level) or orderIds (whole order). No job id needed.
   */
  async listPlacements(params: { detailIds?: number[]; orderIds?: number[] }): Promise<CutDetailPlacements> {
    const query = new URLSearchParams();
    if (params.detailIds && params.detailIds.length > 0) query.append('detailIds', params.detailIds.join(','));
    if (params.orderIds && params.orderIds.length > 0) query.append('orderIds', params.orderIds.join(','));
    const qs = query.toString();
    return httpClient.get<CutDetailPlacements>(qs ? `${apiRoutes.cutJobs.placements}?${qs}` : apiRoutes.cutJobs.placements);
  },

  /** Per-detail latest-created ready (calculated) cut job, for the order-detail Раскрой column. */
  async listDetailLastReady(detailIds: number[]): Promise<CutDetailLastReadyResponse> {
    const ids = detailIds.filter((id) => Number.isInteger(id) && id > 0);
    if (ids.length === 0) return { details: [] };
    const query = new URLSearchParams({ detailIds: ids.join(',') });
    return httpClient.get<CutDetailLastReadyResponse>(
      `${apiRoutes.cutJobs.detailLastReady}?${query.toString()}`,
    );
  },

  async listEligibleDetails(
    cutJobId: number,
    criteria: CutSelectionCriteria,
  ): Promise<EligibleDetailsResponse> {
    const query = buildEligibleQuery(criteria);
    const path = apiRoutes.cutJobs.eligibleDetails(validateCutJobId(cutJobId));
    return httpClient.get<EligibleDetailsResponse>(query ? `${path}?${query}` : path);
  },

  async listEligibleDetailsPreview(criteria: CutSelectionCriteria): Promise<EligibleDetailsResponse> {
    const query = buildEligibleQuery(criteria);
    const path = apiRoutes.cutJobs.eligibleDetailsPreview;
    return httpClient.get<EligibleDetailsResponse>(query ? `${path}?${query}` : path);
  },

  async fetchSheetPng(
    cutJobId: number,
    groupId: number,
    sheetIndex: number,
    preset: string = 'screen',
    landscape = false,
    variant?: 'auto' | 'manual' | 'active',
    renderToken?: string,
    originTopLeft = true,
    axisOrigin: 'top-left' | 'bottom-left' = 'bottom-left',
    resultNo?: number,
  ): Promise<Blob> {
    const path = resultNo === undefined
      ? apiRoutes.cutJobs.sheetPng(validateCutJobId(cutJobId), validateCutJobId(groupId), sheetIndex)
      : apiRoutes.cutJobs.resultSheetPng(validateCutJobId(cutJobId), validateCutJobId(resultNo), validateCutJobId(groupId), sheetIndex);
    const params = new URLSearchParams();
    params.append('preset', preset);
    // On-screen preview always requests no baked labels so the HTML overlay
    // is the sole label source and there is no double-label collision.
    params.append('labels', 'off');
    if (landscape) params.append('orientation', 'landscape');
    // origin top-left (transpose) is the default; emit explicitly so the RAW
    // (legacy 90° CW) half is never silently dead and browser cache keys differ.
    params.append('origin', originTopLeft ? 'tl' : 'raw');
    params.append('axisOrigin', axisOrigin);
    if (variant) params.append('variant', variant);
    if (renderToken) params.append('renderVersion', renderToken);
    const { blob } = await httpClient.download(`${path}?${params.toString()}`);
    return blob;
  },

  async fetchSheetSvg(
    cutJobId: number,
    groupId: number,
    sheetIndex: number,
    landscape = false,
    variant?: 'auto' | 'manual' | 'active',
    renderToken?: string,
    originTopLeft = true,
    axisOrigin: 'top-left' | 'bottom-left' = 'bottom-left',
    resultNo?: number,
  ): Promise<Blob> {
    const path = resultNo === undefined
      ? apiRoutes.cutJobs.sheetSvg(validateCutJobId(cutJobId), validateCutJobId(groupId), sheetIndex)
      : apiRoutes.cutJobs.resultSheetSvg(validateCutJobId(cutJobId), validateCutJobId(resultNo), validateCutJobId(groupId), sheetIndex);
    const params = new URLSearchParams();
    if (landscape) params.append('orientation', 'landscape');
    params.append('origin', originTopLeft ? 'tl' : 'raw');
    params.append('axisOrigin', axisOrigin);
    if (variant) params.append('variant', variant);
    if (renderToken) params.append('renderVersion', renderToken);
    const qs = params.toString();
    const { blob } = await httpClient.download(qs ? `${path}?${qs}` : path);
    return blob;
  },

  /**
   * Group PDF. Current-job exports are freshly rendered by the backend each
   * time; 202 is still accepted for older/result paths that may answer pending.
   */
  fetchGroupPdf(
    cutJobId: number,
    groupId: number,
    landscape = false,
    renderToken?: string,
    originTopLeft = true,
    pdfTemplate?: string,
    axisOrigin: 'top-left' | 'bottom-left' = 'bottom-left',
    resultNo?: number,
  ): Promise<CutPdfResult> {
    const path = resultNo === undefined
      ? apiRoutes.cutJobs.groupPdf(validateCutJobId(cutJobId), validateCutJobId(groupId))
      : apiRoutes.cutJobs.resultGroupPdf(validateCutJobId(cutJobId), validateCutJobId(resultNo), validateCutJobId(groupId));
    const params = new URLSearchParams();
    if (landscape) params.append('orientation', 'landscape');
    params.append('origin', originTopLeft ? 'tl' : 'raw');
    params.append('axisOrigin', axisOrigin);
    if (renderToken) {
      params.append('variant', 'active');
      params.append('renderVersion', renderToken);
    }
    if (pdfTemplate) params.append('template', pdfTemplate);
    const qs = params.toString();
    return downloadPdf(qs ? `${path}?${qs}` : path);
  },

  /**
   * Whole-job PDF. Current-job exports are freshly rendered by the backend each
   * time; 202 is still accepted for older/result paths that may answer pending.
   */
  fetchJobPdf(cutJobId: number, landscape = false, renderToken?: string, originTopLeft = true, pdfTemplate?: string, axisOrigin: 'top-left' | 'bottom-left' = 'bottom-left', resultNo?: number): Promise<CutPdfResult> {
    const path = resultNo === undefined
      ? apiRoutes.cutJobs.jobPdf(validateCutJobId(cutJobId))
      : apiRoutes.cutJobs.resultJobPdf(validateCutJobId(cutJobId), validateCutJobId(resultNo));
    const params = new URLSearchParams();
    if (landscape) params.append('orientation', 'landscape');
    params.append('origin', originTopLeft ? 'tl' : 'raw');
    params.append('axisOrigin', axisOrigin);
    if (renderToken) {
      params.append('variant', 'active');
      params.append('renderVersion', renderToken);
    }
    if (pdfTemplate) params.append('template', pdfTemplate);
    const qs = params.toString();
    return downloadPdf(qs ? `${path}?${qs}` : path);
  },

  /**
   * Save (or update) the manual placement layout for a cut group.
   * PATCH /cut-jobs/:cutJobId/groups/:groupId/manual-layout
   * Returns the full updated CutJobDto with the new renderToken.
   */
  async saveManualLayout(
    cutJobId: number,
    cutGroupId: number,
    body: SaveManualLayoutRequest,
  ): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(
      apiRoutes.cutJobs.manualLayout(validateCutJobId(cutJobId), validateCutJobId(cutGroupId)),
      body,
    );
  },

  async setProfile(cutJobId: number, paramProfileId: number | null, version: number): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(apiRoutes.cutJobs.profile(validateCutJobId(cutJobId)), {
      paramProfileId,
      version,
    });
  },

  async setSheetMaterial(cutJobId: number, sheetMaterialTypeId: number | null, version: number): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(apiRoutes.cutJobs.sheetMaterial(validateCutJobId(cutJobId)), {
      sheetMaterialTypeId,
      version,
    });
  },

  async setCombineFilms(cutJobId: number, combineFilms: boolean, version: number): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(apiRoutes.cutJobs.combineFilms(validateCutJobId(cutJobId)), {
      combineFilms,
      version,
    });
  },

  async setSplitByMaterial(cutJobId: number, splitByMaterial: boolean, version: number): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(apiRoutes.cutJobs.splitByMaterial(validateCutJobId(cutJobId)), {
      splitByMaterial,
      version,
    });
  },

  async setJobPdfTemplate(cutJobId: number, pdfTemplate: string): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(apiRoutes.cutJobs.jobPdfTemplate(validateCutJobId(cutJobId)), {
      pdfTemplate,
    });
  },

  async setName(cutJobId: number, name: string, version: number): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(apiRoutes.cutJobs.name(validateCutJobId(cutJobId)), {
      name,
      version,
    });
  },

  async setGroupPdfTemplate(cutJobId: number, cutGroupId: number, pdfTemplate: string): Promise<CutJobDto> {
    return httpClient.patch<CutJobDto>(
      apiRoutes.cutJobs.groupPdfTemplate(validateCutJobId(cutJobId), validateCutJobId(cutGroupId)),
      { pdfTemplate },
    );
  },
};

export type CutPdfResult = { pending: true } | { pending: false; blob: Blob; fileName: string | null };

async function downloadPdf(path: string): Promise<CutPdfResult> {
  const { blob, fileName, status } = await httpClient.download(path);
  // 202: render in progress (the body is a pending JSON, not a PDF).
  if (status === 202) {
    return { pending: true };
  }
  return { pending: false, blob, fileName };
}

/** Pure CSV query builder (testable without a network call). */
export function buildEligibleQuery(criteria: CutSelectionCriteria): string {
  const params = new URLSearchParams();
  appendCsv(params, 'orderIds', criteria.orderIds);
  appendCsv(params, 'sheetMaterialTypeIds', criteria.sheetMaterialTypeIds);
  appendCsv(params, 'filmIds', criteria.filmIds);
  appendCsv(params, 'productionStatusIds', criteria.productionStatusIds);
  appendDate(params, 'dateFrom', criteria.dateFrom);
  appendDate(params, 'dateTo', criteria.dateTo);
  return params.toString();
}

function appendCsv(params: URLSearchParams, key: string, values: number[] | undefined): void {
  if (values && values.length > 0) {
    params.append(key, values.join(','));
  }
}

function appendDate(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) {
    params.append(key, value);
  }
}

export function validateCutJobId(cutJobId: number): number {
  if (!Number.isInteger(cutJobId) || cutJobId < 1) {
    throw new Error('Invalid cutJobId');
  }
  return cutJobId;
}
