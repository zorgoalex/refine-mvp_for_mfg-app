import { describe, expect, it, vi } from 'vitest';
import type { CutParamProfile } from '../../api/cutConfigApi';
import type { CutJobDto, CutSheetTypeOption, CutTextureDirection } from '../../api/types/cutApi.types';
import {
  applyCutProfileSelection,
  firstBathSheetMaterialId,
  isVacuumTableProfile,
  isVacuumTableJob,
  resolveCutJobLayoutKind,
  resolveSheetAxisOriginForJob,
  textureDirectionForCutProfile,
} from './cutVacuumProfile';

const profile = (id: number, layoutMode: string, params: Record<string, unknown> = {}): CutParamProfile => ({
  cutParamProfileId: id,
  name: `P${id}`,
  params: { layout_mode: layoutMode, ...params },
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
  createdAt: '2026-08-07T00:00:00.000Z',
  version: 10,
  pdfPrewarmState: 'idle',
  paramProfileId: null,
  sheetMaterialTypeId: null,
  pdfTemplate: 'standard',
  combineFilms: true,
  splitByMaterial: true,
  rotationAllowed: true,
  textureDirection: 'none',
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

  it('resolves profile-implied texture direction for vacuum-table profiles', () => {
    const profiles = [
      profile(1, 'vacuum_table', { vacuum: { direction: 'width' } }),
      profile(2, 'vacuum_table', { vacuum: { direction: 'height' } }),
      profile(3, 'vacuum_table', { vacuum: { direction: 'optimal' } }),
      profile(4, 'vacuum_table'),
      profile(5, 'guillotine'),
    ];

    expect(textureDirectionForCutProfile(1, profiles)).toBe('vertical');
    expect(textureDirectionForCutProfile(2, profiles)).toBe('horizontal');
    expect(textureDirectionForCutProfile(3, profiles)).toBe('none');
    expect(textureDirectionForCutProfile(4, profiles)).toBe('none');
    expect(textureDirectionForCutProfile(5, profiles)).toBeNull();
    expect(textureDirectionForCutProfile(null, profiles)).toBeNull();
    expect(textureDirectionForCutProfile(999, profiles)).toBeNull();
  });

  it('opens every non-vacuum profile top-left and preserves the saved vacuum origin', () => {
    const profiles = [profile(4, 'vacuum_table'), profile(5, 'guillotine')];

    expect(resolveSheetAxisOriginForJob(5, profiles, 'bottom-left')).toBe('top-left');
    expect(resolveSheetAxisOriginForJob(null, profiles, 'bottom-left')).toBe('top-left');
    expect(resolveSheetAxisOriginForJob(4, profiles, 'bottom-left')).toBe('bottom-left');
    expect(resolveSheetAxisOriginForJob(4, profiles, 'top-left')).toBe('top-left');
  });

  it('uses the calculated engine for frozen results when the profile catalog changed', () => {
    const profiles = [profile(4, 'vacuum_table'), profile(5, 'guillotine')];

    expect(resolveSheetAxisOriginForJob(5, profiles, 'bottom-left', 'vacuum_table', null, true))
      .toBe('bottom-left');
    expect(resolveSheetAxisOriginForJob(4, profiles, 'bottom-left', 'guillotine', null, true))
      .toBe('top-left');
    expect(isVacuumTableJob(5, profiles, 'vacuum_table', true)).toBe(true);
  });

  it('uses the current profile for live jobs with groups from an older calculation', () => {
    const profiles = [profile(4, 'vacuum_table'), profile(5, 'guillotine')];

    expect(resolveSheetAxisOriginForJob(5, profiles, 'bottom-left', 'vacuum_table'))
      .toBe('top-left');
    expect(resolveSheetAxisOriginForJob(4, profiles, 'bottom-left', 'guillotine'))
      .toBe('bottom-left');
  });

  it('preserves a later explicit user choice after applying the non-vacuum default once', () => {
    const profiles = [profile(5, 'guillotine')];

    expect(resolveSheetAxisOriginForJob(5, profiles, 'bottom-left', 'guillotine', 'bottom-left'))
      .toBe('bottom-left');
  });

  it('does not classify a profile until its catalog row or calculated engine is available', () => {
    expect(resolveCutJobLayoutKind(4, [], undefined)).toBe('unknown');
    expect(resolveSheetAxisOriginForJob(4, [], 'bottom-left')).toBe('bottom-left');
  });

  it('chooses the first list item whose trimmed name starts with «ванна»', () => {
    const options = [sheet(1, 'МДФ'), sheet(2, '  Ванна 2800x1050'), sheet(3, 'ванна запасная')];

    expect(firstBathSheetMaterialId(options)).toBe(2);
    expect(firstBathSheetMaterialId([sheet(1, 'МДФ')])).toBeNull();
  });

  it('turns both flags off and selects the first bath sheet using returned versions', async () => {
    const calls: Array<[string, number, number | boolean | string | null, number]> = [];
    const advance = (current: CutJobDto, patch: Partial<CutJobDto>) => job({ ...current, ...patch, version: current.version + 1 });
    const mutations = {
      setProfile: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['profile', jobId, value, version]);
        return advance(job({ version }), { paramProfileId: value });
      }),
      setTextureDirection: vi.fn(async (jobId: number, value: CutTextureDirection, version: number) => {
        calls.push(['texture', jobId, value, version]);
        return advance(job({ version, paramProfileId: 4 }), { textureDirection: value });
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

  it('sets the profile-implied texture direction before applying other vacuum defaults', async () => {
    const calls: Array<[string, number, number | boolean | string | null, number]> = [];
    const mutations = {
      setProfile: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['profile', jobId, value, version]);
        return job({ version: 11, paramProfileId: value, textureDirection: 'none' });
      }),
      setTextureDirection: vi.fn(async (jobId: number, value: CutTextureDirection, version: number) => {
        calls.push(['texture', jobId, value, version]);
        return job({ version: 12, paramProfileId: 4, textureDirection: value });
      }),
      setSplitByMaterial: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['split', jobId, value, version]);
        return job({ version: 13, paramProfileId: 4, textureDirection: 'vertical', splitByMaterial: value });
      }),
      setCombineFilms: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['combine', jobId, value, version]);
        return job({ version: 14, paramProfileId: 4, textureDirection: 'vertical', splitByMaterial: false, combineFilms: value });
      }),
      setSheetMaterial: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['sheet', jobId, value, version]);
        return job({ version: 15, paramProfileId: 4, textureDirection: 'vertical', splitByMaterial: false, combineFilms: false, sheetMaterialTypeId: value });
      }),
    };

    const result = await applyCutProfileSelection({
      currentJob: job(),
      paramProfileId: 4,
      profiles: [profile(4, 'vacuum_table', { vacuum: { direction: 'width' } })],
      sheetOptions: [sheet(2, 'Ванна 2800x1050')],
      mutations,
    });

    expect(calls).toEqual([
      ['profile', 17, 4, 10],
      ['texture', 17, 'vertical', 11],
      ['split', 17, false, 12],
      ['combine', 17, false, 13],
      ['sheet', 17, 2, 14],
    ]);
    expect(result.job).toMatchObject({ version: 15, textureDirection: 'vertical', sheetMaterialTypeId: 2 });
  });

  it('reports a missing bath sheet after disabling both flags', async () => {
    const mutations = {
      setProfile: vi.fn(async () => job({ version: 11, paramProfileId: 4 })),
      setTextureDirection: vi.fn(async () => job({ version: 12, paramProfileId: 4, textureDirection: 'none' })),
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
