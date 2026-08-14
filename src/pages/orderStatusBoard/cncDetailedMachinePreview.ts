import { cncTelegramApi } from '../../api/cncTelegramApi';
import { cutApi } from '../../api/cutApi';
import type { CutResultDto } from '../../api/types/cutApi.types';
import { CUT_RENDER_STYLE_MDF_BOARD_PREVIEW } from '@shared/cut-render-style';
import {
  selectCncMachineResultSheets,
  type CncDetailedMachineSource,
  type CncMachineResultSheet,
} from './cncDetailedMachine';
import { NON_VACUUM_SHEET_AXIS_ORIGIN } from '../cut/cutVacuumProfile';

export const CNC_MACHINE_RESULT_CACHE_LIMIT = 32;
export const CNC_MACHINE_SVG_CACHE_LIMIT = 128;
export const CNC_MACHINE_SCREENSHOT_CACHE_LIMIT = 64;

export interface CncDetailedMachineSvgSheet extends CncMachineResultSheet {
  svgText: string;
}

export interface CncDetailedMachineSvgPreview {
  result: CutResultDto;
  sheets: CncDetailedMachineSvgSheet[];
}

export function cncDetailedMachinePreviewsShareSheets(
  current: CncDetailedMachineSvgPreview | null,
  next: CncDetailedMachineSvgPreview,
): boolean {
  return current !== null
    && current.sheets.length === next.sheets.length
    && current.sheets.every((sheet, index) => sheet.key === next.sheets[index]?.key);
}

export interface CncDetailedMachinePreviewDependencies {
  getResult(cutJobId: number, resultNo: number): Promise<CutResultDto>;
  fetchSheetSvg(
    cutJobId: number,
    groupId: number,
    sheetIndex: number,
    renderToken: string,
    resultNo: number,
  ): Promise<Blob>;
  fetchScreenshot(imageUrl: string): Promise<Blob>;
}

export class CncDetailedMachinePreviewError extends Error {
  constructor(
    public readonly code: 'INVALID_SOURCE' | 'DETAIL_SHEET_NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'CncDetailedMachinePreviewError';
  }
}

class LruCache<Key, Value> {
  private readonly values = new Map<Key, Value>();

  constructor(private readonly limit: number) {}

  get(key: Key): Value | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: Key, value: Value): void {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      const oldestKey = this.values.keys().next().value as Key | undefined;
      if (oldestKey === undefined) break;
      this.values.delete(oldestKey);
    }
  }

  clear(): void {
    this.values.clear();
  }
}

const defaultDependencies: CncDetailedMachinePreviewDependencies = {
  getResult: (cutJobId, resultNo) => cutApi.getResult(cutJobId, resultNo),
  fetchSheetSvg: (cutJobId, groupId, sheetIndex, renderToken, resultNo) => (
    cutApi.fetchSheetSvg(
      cutJobId,
      groupId,
      sheetIndex,
      false,
      undefined,
      renderToken,
      false,
      NON_VACUUM_SHEET_AXIS_ORIGIN,
      resultNo,
      true,
      CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
    )
  ),
  fetchScreenshot: async (imageUrl) => (await cncTelegramApi.downloadSheetImage(imageUrl)).blob,
};

const resultCache = new LruCache<string, CutResultDto>(CNC_MACHINE_RESULT_CACHE_LIMIT);
const svgCache = new LruCache<string, string>(CNC_MACHINE_SVG_CACHE_LIMIT);
const screenshotCache = new LruCache<string, Blob>(CNC_MACHINE_SCREENSHOT_CACHE_LIMIT);
const resultRequests = new Map<string, Promise<CutResultDto>>();
const svgRequests = new Map<string, Promise<string>>();
const screenshotRequests = new Map<string, Promise<Blob>>();

export async function loadCncDetailedMachineSvgPreview(
  source: CncDetailedMachineSource,
  selectedDetailId: number | null,
  dependencies: CncDetailedMachinePreviewDependencies = defaultDependencies,
): Promise<CncDetailedMachineSvgPreview> {
  if (source.previewKind !== 'svg' || source.cutJobId === null || source.resultNo === null) {
    throw new CncDetailedMachinePreviewError('INVALID_SOURCE', 'SVG-раскладка не привязана');
  }

  const resultKey = `${source.cutJobId}:${source.resultNo}`;
  const result = await loadCached(
    resultCache,
    resultRequests,
    resultKey,
    () => dependencies.getResult(source.cutJobId!, source.resultNo!),
  );
  const matchingSheets = selectCncMachineResultSheets(result, selectedDetailId);
  if (selectedDetailId !== null && matchingSheets.length === 0) {
    throw new CncDetailedMachinePreviewError(
      'DETAIL_SHEET_NOT_FOUND',
      'В привязанной SVG-раскладке деталь не найдена',
    );
  }

  const sheets = await Promise.all(matchingSheets.map(async (sheet) => {
    const svgText = await loadCached(
      svgCache,
      svgRequests,
      sheet.key,
      async () => {
        const blob = await dependencies.fetchSheetSvg(
          sheet.cutJobId,
          sheet.cutGroupId,
          sheet.sheetIndex,
          result.renderToken,
          sheet.resultNo,
        );
        return blob.text();
      },
    );
    return { ...sheet, svgText };
  }));

  return { result, sheets };
}

export function loadCncDetailedMachineScreenshot(
  imageUrl: string,
  dependencies: CncDetailedMachinePreviewDependencies = defaultDependencies,
): Promise<Blob> {
  return loadCached(
    screenshotCache,
    screenshotRequests,
    imageUrl,
    () => dependencies.fetchScreenshot(imageUrl),
  );
}

export function clearCncDetailedMachinePreviewCaches(): void {
  resultCache.clear();
  svgCache.clear();
  screenshotCache.clear();
  resultRequests.clear();
  svgRequests.clear();
  screenshotRequests.clear();
}

async function loadCached<Key, Value>(
  cache: LruCache<Key, Value>,
  requests: Map<Key, Promise<Value>>,
  key: Key,
  loader: () => Promise<Value>,
): Promise<Value> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const pending = requests.get(key);
  if (pending) return pending;

  const request = loader()
    .then((value) => {
      cache.set(key, value);
      return value;
    })
    .finally(() => {
      requests.delete(key);
    });
  requests.set(key, request);
  return request;
}
