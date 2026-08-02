import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CutResultDto } from '../../api/types/cutApi.types';
import type { CncDetailedMachineSource } from './cncDetailedMachine';
import {
  CNC_MACHINE_RESULT_CACHE_LIMIT,
  CNC_MACHINE_SCREENSHOT_CACHE_LIMIT,
  CNC_MACHINE_SVG_CACHE_LIMIT,
  cncDetailedMachinePreviewsShareSheets,
  clearCncDetailedMachinePreviewCaches,
  loadCncDetailedMachineScreenshot,
  loadCncDetailedMachineSvgPreview,
  type CncDetailedMachinePreviewDependencies,
} from './cncDetailedMachinePreview';

describe('CNC detailed machine preview cache', () => {
  beforeEach(() => clearCncDetailedMachinePreviewCaches());

  it('reuses the same result and SVG sheet when switching detail A → B → A', async () => {
    const dependencies = previewDependencies();
    vi.mocked(dependencies.getResult).mockResolvedValue(
      result(35, 3, [0], ['det-7001', 'det-7002']),
    );

    await loadCncDetailedMachineSvgPreview(source(35, 3), 7001, dependencies);
    const detailB = await loadCncDetailedMachineSvgPreview(source(35, 3), 7002, dependencies);
    const detailA = await loadCncDetailedMachineSvgPreview(source(35, 3), 7001, dependencies);

    expect(cncDetailedMachinePreviewsShareSheets(detailA, detailB)).toBe(true);
    expect(dependencies.getResult).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchSheetSvg).toHaveBeenCalledTimes(1);
  });

  it('does not poison a cache after a failed request', async () => {
    const dependencies = previewDependencies();
    vi.mocked(dependencies.fetchSheetSvg)
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(new Blob(['<svg data-detail-id="7001"/>'], { type: 'image/svg+xml' }));

    await expect(loadCncDetailedMachineSvgPreview(source(35, 3), 7001, dependencies))
      .rejects.toThrow('network');
    await expect(loadCncDetailedMachineSvgPreview(source(35, 3), 7001, dependencies))
      .resolves.toMatchObject({ sheets: [{ sheetIndex: 0 }] });

    expect(dependencies.getResult).toHaveBeenCalledTimes(1);
    expect(dependencies.fetchSheetSvg).toHaveBeenCalledTimes(2);
  });

  it('commits a multi-sheet preview atomically and retries only the failed sheet', async () => {
    const dependencies = previewDependencies();
    vi.mocked(dependencies.getResult).mockResolvedValue(result(35, 3, [0, 1]));
    vi.mocked(dependencies.fetchSheetSvg).mockImplementation(async (
      _cutJobId,
      _groupId,
      sheetIndex,
    ) => {
      if (sheetIndex === 1) throw new Error('second sheet failed');
      return new Blob(['<svg/>'], { type: 'image/svg+xml' });
    });

    await expect(loadCncDetailedMachineSvgPreview(source(35, 3), 7001, dependencies))
      .rejects.toThrow('second sheet failed');
    vi.mocked(dependencies.fetchSheetSvg).mockResolvedValue(
      new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    );
    await expect(loadCncDetailedMachineSvgPreview(source(35, 3), 7001, dependencies))
      .resolves.toMatchObject({ sheets: [{ sheetIndex: 0 }, { sheetIndex: 1 }] });

    expect(dependencies.fetchSheetSvg).toHaveBeenCalledTimes(3);
  });

  it('deduplicates screenshot blobs without caching object URLs', async () => {
    const dependencies = previewDependencies();

    const first = await loadCncDetailedMachineScreenshot('/sheet.jpg', dependencies);
    const second = await loadCncDetailedMachineScreenshot('/sheet.jpg', dependencies);

    expect(first).toBe(second);
    expect(dependencies.fetchScreenshot).toHaveBeenCalledTimes(1);
  });

  it('uses bounded LRU caches and evicts the least recently used result', async () => {
    expect(CNC_MACHINE_RESULT_CACHE_LIMIT).toBe(32);
    expect(CNC_MACHINE_SVG_CACHE_LIMIT).toBe(128);
    expect(CNC_MACHINE_SCREENSHOT_CACHE_LIMIT).toBe(64);
    const dependencies = previewDependencies();

    for (let index = 0; index <= CNC_MACHINE_RESULT_CACHE_LIMIT; index += 1) {
      await loadCncDetailedMachineSvgPreview(source(100 + index, 1), 7001, dependencies);
    }
    await loadCncDetailedMachineSvgPreview(source(100, 1), 7001, dependencies);

    expect(dependencies.getResult).toHaveBeenCalledTimes(CNC_MACHINE_RESULT_CACHE_LIMIT + 2);
  });

  it('evicts least-recent SVG strings and screenshot blobs at their limits', async () => {
    const dependencies = previewDependencies();
    for (let index = 0; index <= CNC_MACHINE_SVG_CACHE_LIMIT; index += 1) {
      await loadCncDetailedMachineSvgPreview(source(1_000 + index, 1), 7001, dependencies);
    }
    await loadCncDetailedMachineSvgPreview(source(1_000, 1), 7001, dependencies);
    expect(dependencies.fetchSheetSvg).toHaveBeenCalledTimes(CNC_MACHINE_SVG_CACHE_LIMIT + 2);

    clearCncDetailedMachinePreviewCaches();
    const screenshotDependencies = previewDependencies();
    for (let index = 0; index <= CNC_MACHINE_SCREENSHOT_CACHE_LIMIT; index += 1) {
      await loadCncDetailedMachineScreenshot(`/sheet-${index}.jpg`, screenshotDependencies);
    }
    await loadCncDetailedMachineScreenshot('/sheet-0.jpg', screenshotDependencies);
    expect(screenshotDependencies.fetchScreenshot)
      .toHaveBeenCalledTimes(CNC_MACHINE_SCREENSHOT_CACHE_LIMIT + 2);
  });
});

function source(cutJobId: number, resultNo: number): CncDetailedMachineSource {
  return {
    packet: { packetId: `packet-${cutJobId}` } as CncDetailedMachineSource['packet'],
    matchKind: 'exact',
    previewKind: 'svg',
    cutJobId,
    resultNo,
    imageUrl: '/sheet.jpg',
    svgPermissionRequired: false,
  };
}

function previewDependencies(): CncDetailedMachinePreviewDependencies {
  return {
    getResult: vi.fn(async (cutJobId: number, resultNo: number) => result(cutJobId, resultNo)),
    fetchSheetSvg: vi.fn(async () => new Blob([
      '<svg><g data-detail-id="7001" data-detail-selected="false"/></svg>',
    ], { type: 'image/svg+xml' })),
    fetchScreenshot: vi.fn(async () => new Blob(['image'], { type: 'image/jpeg' })),
  };
}

function result(
  cutJobId: number,
  resultNo: number,
  sheetIndexes = [0],
  itemIds = ['det-7001'],
): CutResultDto {
  return {
    cutJobId,
    resultNo,
    renderToken: `result-${cutJobId}-${resultNo}`,
    job: {
      groups: [{
        cutGroupId: cutJobId * 10,
        sheets: sheetIndexes.map((sheetIndex) => ({
          sheetIndex,
          placements: {
            pieces: itemIds.map((itemId) => ({ item_id: itemId })),
          },
        })),
      }],
    },
  } as unknown as CutResultDto;
}
