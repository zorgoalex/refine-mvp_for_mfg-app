import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  AddCutItemsRequest,
  CreateCutJobRequest,
  CutJobDto,
  CutSelectionCriteria,
  EligibleDetailsResponse,
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

  async calculate(cutJobId: number, version: number): Promise<CutJobDto> {
    return httpClient.post<CutJobDto>(apiRoutes.cutJobs.calculate(validateCutJobId(cutJobId)), {
      version,
    });
  },

  async archive(cutJobId: number, version: number): Promise<CutJobDto> {
    return httpClient.delete<CutJobDto>(apiRoutes.cutJobs.byId(validateCutJobId(cutJobId)), {
      body: JSON.stringify({ version }),
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async listEligibleDetails(
    cutJobId: number,
    criteria: CutSelectionCriteria,
  ): Promise<EligibleDetailsResponse> {
    const query = buildEligibleQuery(criteria);
    const path = apiRoutes.cutJobs.eligibleDetails(validateCutJobId(cutJobId));
    return httpClient.get<EligibleDetailsResponse>(query ? `${path}?${query}` : path);
  },

  async fetchSheetPng(
    cutJobId: number,
    groupId: number,
    sheetIndex: number,
    preset: string = 'screen',
  ): Promise<Blob> {
    const path = apiRoutes.cutJobs.sheetPng(
      validateCutJobId(cutJobId),
      validateCutJobId(groupId),
      sheetIndex,
    );
    const { blob } = await httpClient.download(`${path}?preset=${encodeURIComponent(preset)}`);
    return blob;
  },

  async fetchSheetSvg(cutJobId: number, groupId: number, sheetIndex: number): Promise<Blob> {
    const path = apiRoutes.cutJobs.sheetSvg(
      validateCutJobId(cutJobId),
      validateCutJobId(groupId),
      sheetIndex,
    );
    const { blob } = await httpClient.download(path);
    return blob;
  },

  /** Group PDF. 202 (cold cache) -> `{ pending: true }`; caller retries. */
  fetchGroupPdf(cutJobId: number, groupId: number): Promise<CutPdfResult> {
    return downloadPdf(
      apiRoutes.cutJobs.groupPdf(validateCutJobId(cutJobId), validateCutJobId(groupId)),
    );
  },

  /** Whole-job PDF. 202 (cold cache) -> `{ pending: true }`; caller retries. */
  fetchJobPdf(cutJobId: number): Promise<CutPdfResult> {
    return downloadPdf(apiRoutes.cutJobs.jobPdf(validateCutJobId(cutJobId)));
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
  appendCsv(params, 'materialIds', criteria.materialIds);
  appendCsv(params, 'filmIds', criteria.filmIds);
  appendCsv(params, 'productionStatusIds', criteria.productionStatusIds);
  return params.toString();
}

function appendCsv(params: URLSearchParams, key: string, values: number[] | undefined): void {
  if (values && values.length > 0) {
    params.append(key, values.join(','));
  }
}

export function validateCutJobId(cutJobId: number): number {
  if (!Number.isInteger(cutJobId) || cutJobId < 1) {
    throw new Error('Invalid cutJobId');
  }
  return cutJobId;
}
