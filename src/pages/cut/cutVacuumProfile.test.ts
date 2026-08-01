import { describe, expect, it, vi } from 'vitest';
import type { CutParamProfile } from '../../api/cutConfigApi';
import type { CutJobDto, CutSheetTypeOption } from '../../api/types/cutApi.types';
import {
  applyCutProfileSelection,
  firstBathSheetMaterialId,
  isVacuumTableProfile,
} from './cutVacuumProfile';

const profile = (id: number, layoutMode: string): CutParamProfile => ({
  cutParamProfileId: id,
  name: `P${id}`,
  params: { layout_mode: layoutMode },
  isDefault: false,
  isActive: true,
  version: 1,
});

const sheet = (id: number, name: string): CutSheetTypeOption => ({
  sheetMaterialTypeId: id,
  name,
  materialTypeId: id,
  thicknessMm: 18,
  widthMm: 2800,
  heightMm: 1050,
  isCuttable: true,
});

const job = (overrides: Partial<CutJobDto> = {}): CutJobDto => ({
  cutJobId: 17,
  name: 'Тест',
  status: 'draft',
  source: 'manual',
  version: 10,
  pdfPrewarmState: 'idle',
  paramProfileId: null,
  sheetMaterialTypeId: null,
  pdfTemplate: 'standard',
  combineFilms: true,
  splitByMaterial: true,
  materialNames: [],
  totals: { positions: 0, details: 0, area: 0, sheets: 0, materialsCount: 0, filmsCount: 0 },
  items: [],
  groups: [],
  ...overrides,
});

describe('vacuum profile defaults', () => {
  it('detects vacuum_table by profile params', () => {
    const profiles = [profile(4, 'vacuum_table'), profile(5, 'guillotine')];

    expect(isVacuumTableProfile(4, profiles)).toBe(true);
    expect(isVacuumTableProfile(5, profiles)).toBe(false);
    expect(isVacuumTableProfile(null, profiles)).toBe(false);
  });

  it('chooses the first list item whose trimmed name starts with «ванна»', () => {
    const options = [sheet(1, 'МДФ'), sheet(2, '  Ванна 2800x1050'), sheet(3, 'ванна запасная')];

    expect(firstBathSheetMaterialId(options)).toBe(2);
    expect(firstBathSheetMaterialId([sheet(1, 'МДФ')])).toBeNull();
  });

  it('turns both flags off and selects the first bath sheet using returned versions', async () => {
    const calls: Array<[string, number, number | boolean | null, number]> = [];
    const advance = (current: CutJobDto, patch: Partial<CutJobDto>) => job({ ...current, ...patch, version: current.version + 1 });
    const mutations = {
      setProfile: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['profile', jobId, value, version]);
        return advance(job({ version }), { paramProfileId: value });
      }),
      setSplitByMaterial: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['split', jobId, value, version]);
        return advance(job({ version, paramProfileId: 4, splitByMaterial: true, combineFilms: true }), { splitByMaterial: value });
      }),
      setCombineFilms: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['combine', jobId, value, version]);
        return advance(job({ version, paramProfileId: 4, splitByMaterial: false, combineFilms: true }), { combineFilms: value });
      }),
      setSheetMaterial: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['sheet', jobId, value, version]);
        return advance(job({ version, paramProfileId: 4, splitByMaterial: false, combineFilms: false }), { sheetMaterialTypeId: value });
      }),
    };
    const onUpdated = vi.fn();

    const result = await applyCutProfileSelection({
      currentJob: job(),
      paramProfileId: 4,
      profiles: [profile(4, 'vacuum_table')],
      sheetOptions: [sheet(1, 'МДФ'), sheet(2, 'Ванна 2800x1050'), sheet(3, 'Ванна 2800x900')],
      mutations,
      onUpdated,
    });

    expect(calls).toEqual([
      ['profile', 17, 4, 10],
      ['split', 17, false, 11],
      ['combine', 17, false, 12],
      ['sheet', 17, 2, 13],
    ]);
    expect(onUpdated).toHaveBeenCalledTimes(4);
    expect(result.job).toMatchObject({ version: 14, splitByMaterial: false, combineFilms: false, sheetMaterialTypeId: 2 });
    expect(result.bathSheetMissing).toBe(false);
  });

  it('reports a missing bath sheet after disabling both flags', async () => {
    const mutations = {
      setProfile: vi.fn(async () => job({ version: 11, paramProfileId: 4 })),
      setSplitByMaterial: vi.fn(async () => job({ version: 12, paramProfileId: 4, splitByMaterial: false })),
      setCombineFilms: vi.fn(async () => job({ version: 13, paramProfileId: 4, splitByMaterial: false, combineFilms: false })),
      setSheetMaterial: vi.fn(),
    };

    const result = await applyCutProfileSelection({
      currentJob: job(),
      paramProfileId: 4,
      profiles: [profile(4, 'vacuum_table')],
      sheetOptions: [sheet(1, 'МДФ')],
      mutations,
    });

    expect(result.bathSheetMissing).toBe(true);
    expect(result.job).toMatchObject({ splitByMaterial: false, combineFilms: false });
    expect(mutations.setSheetMaterial).not.toHaveBeenCalled();
  });
});
