import { describe, expect, it, vi } from 'vitest';
import type { CutParamProfile } from '../../api/cutConfigApi';
import type { CutJobDto, CutSheetTypeOption, CutTextureDirection } from '../../api/types/cutApi.types';
import {
  applyCutProfileSelection,
  applyCutTextureDirection,
  firstBathSheetMaterialId,
  isVacuumTableProfile,
  isVacuumTableJob,
  profileDrivenCutJobName,
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

  it('switches only auto-managed cut job name prefixes for vacuum/non-vacuum profiles', () => {
    const profiles = [profile(4, 'vacuum_table'), profile(5, 'guillotine')];

    expect(profileDrivenCutJobName('Раскрой 2709', 4, profiles)).toBe('Ванна 2709');
    expect(profileDrivenCutJobName('Ванна 2709', 5, profiles)).toBe('Раскрой 2709');
    expect(profileDrivenCutJobName('  Раскрой 2709', 4, profiles)).toBe('  Ванна 2709');
    expect(profileDrivenCutJobName('Срочный 2709', 4, profiles)).toBe('Срочный 2709');
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
      setRotationAllowed: vi.fn(),
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

  it('turns rotation off and sets the profile-implied texture direction before other vacuum defaults', async () => {
    const calls: Array<[string, number, number | boolean | string | null, number]> = [];
    const mutations = {
      setProfile: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['profile', jobId, value, version]);
        return job({ version: 11, paramProfileId: value, textureDirection: 'none' });
      }),
      setRotationAllowed: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['rotation', jobId, value, version]);
        return job({ version: 12, paramProfileId: 4, textureDirection: 'none', rotationAllowed: value });
      }),
      setTextureDirection: vi.fn(async (jobId: number, value: CutTextureDirection, version: number) => {
        calls.push(['texture', jobId, value, version]);
        return job({ version: 13, paramProfileId: 4, textureDirection: value, rotationAllowed: false });
      }),
      setSplitByMaterial: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['split', jobId, value, version]);
        return job({ version: 14, paramProfileId: 4, textureDirection: 'vertical', rotationAllowed: false, splitByMaterial: value });
      }),
      setCombineFilms: vi.fn(async (jobId: number, value: boolean, version: number) => {
        calls.push(['combine', jobId, value, version]);
        return job({ version: 15, paramProfileId: 4, textureDirection: 'vertical', rotationAllowed: false, splitByMaterial: false, combineFilms: value });
      }),
      setSheetMaterial: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['sheet', jobId, value, version]);
        return job({ version: 16, paramProfileId: 4, textureDirection: 'vertical', rotationAllowed: false, splitByMaterial: false, combineFilms: false, sheetMaterialTypeId: value });
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
      ['rotation', 17, false, 11],
      ['texture', 17, 'vertical', 12],
      ['split', 17, false, 13],
      ['combine', 17, false, 14],
      ['sheet', 17, 2, 15],
    ]);
    expect(result.job).toMatchObject({
      version: 16,
      textureDirection: 'vertical',
      rotationAllowed: false,
      sheetMaterialTypeId: 2,
    });
  });

  it('turns rotation off when the texture direction changes to вдоль/поперёк полотна', async () => {
    for (const direction of ['vertical', 'horizontal'] as const) {
      const calls: Array<[string, CutTextureDirection | boolean, number]> = [];
      const mutations = {
        setRotationAllowed: vi.fn(async (_jobId: number, value: boolean, version: number) => {
          calls.push(['rotation', value, version]);
          return job({ version: version + 1, textureDirection: 'none', rotationAllowed: value });
        }),
        setTextureDirection: vi.fn(async (_jobId: number, value: CutTextureDirection, version: number) => {
          calls.push(['texture', value, version]);
          return job({ version: version + 1, textureDirection: value, rotationAllowed: false });
        }),
      };
      const onUpdated = vi.fn();

      const result = await applyCutTextureDirection({
        currentJob: job({ textureDirection: 'none', rotationAllowed: true }),
        textureDirection: direction,
        mutations,
        onUpdated,
      });

      expect(calls).toEqual([['rotation', false, 10], ['texture', direction, 11]]);
      expect(onUpdated).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ version: 12, textureDirection: direction, rotationAllowed: false });
    }
  });

  it('completes the change on retry after a transient failure to save the direction once rotation is off', async () => {
    let failTexture = true;
    const mutations = {
      setRotationAllowed: vi.fn(async (_jobId: number, value: boolean, version: number) =>
        job({ version: version + 1, textureDirection: 'none', rotationAllowed: value })),
      setTextureDirection: vi.fn(async (_jobId: number, value: CutTextureDirection, version: number) => {
        if (failTexture) throw new Error('network error');
        return job({ version: version + 1, textureDirection: value, rotationAllowed: false });
      }),
    };
    const published: CutJobDto[] = [];

    await expect(applyCutTextureDirection({
      currentJob: job({ textureDirection: 'none', rotationAllowed: true }),
      textureDirection: 'vertical',
      mutations,
      onUpdated: (updated) => published.push(updated),
    })).rejects.toThrow('network error');
    // The safe half is already visible: rotation off, direction unchanged.
    expect(published.at(-1)).toMatchObject({ version: 11, textureDirection: 'none', rotationAllowed: false });

    failTexture = false;
    const retried = await applyCutTextureDirection({
      currentJob: published.at(-1)!,
      textureDirection: 'vertical',
      mutations,
    });

    expect(retried).toMatchObject({ version: 12, textureDirection: 'vertical', rotationAllowed: false });
    expect(mutations.setRotationAllowed).toHaveBeenCalledTimes(1);
    expect(mutations.setTextureDirection).toHaveBeenCalledTimes(2);
  });

  it('keeps rotation untouched for «отсутствует», an already-off box or an unchanged direction', async () => {
    const mutations = {
      setTextureDirection: vi.fn(async (_jobId: number, value: CutTextureDirection, version: number) =>
        job({ version: version + 1, textureDirection: value, rotationAllowed: value === 'none' })),
      setRotationAllowed: vi.fn(),
    };

    const toNone = await applyCutTextureDirection({
      currentJob: job({ textureDirection: 'vertical', rotationAllowed: true }),
      textureDirection: 'none',
      mutations,
    });
    expect(toNone).toMatchObject({ textureDirection: 'none', rotationAllowed: true });

    const alreadyOff = await applyCutTextureDirection({
      currentJob: job({ textureDirection: 'none', rotationAllowed: false }),
      textureDirection: 'horizontal',
      mutations,
    });
    expect(alreadyOff).toMatchObject({ textureDirection: 'horizontal', rotationAllowed: false });

    // The operator re-checked rotation by hand; re-selecting the same direction keeps it.
    const unchanged = job({ textureDirection: 'vertical', rotationAllowed: true });
    expect(await applyCutTextureDirection({
      currentJob: unchanged,
      textureDirection: 'vertical',
      mutations,
    })).toBe(unchanged);

    expect(mutations.setTextureDirection).toHaveBeenCalledTimes(2);
    expect(mutations.setRotationAllowed).not.toHaveBeenCalled();
  });

  it('renames an auto-created cut job to Ванна when selecting a vacuum profile', async () => {
    const calls: Array<[string, number, number | string | null, number]> = [];
    const mutations = {
      setProfile: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['profile', jobId, value, version]);
        return job({
          name: 'Раскрой 2709',
          version: 11,
          paramProfileId: value,
          splitByMaterial: false,
          combineFilms: false,
          sheetMaterialTypeId: 2,
        });
      }),
      setName: vi.fn(async (jobId: number, value: string, version: number) => {
        calls.push(['name', jobId, value, version]);
        return job({
          name: value,
          version: 12,
          paramProfileId: 4,
          splitByMaterial: false,
          combineFilms: false,
          sheetMaterialTypeId: 2,
        });
      }),
      setTextureDirection: vi.fn(),
      setRotationAllowed: vi.fn(),
      setSplitByMaterial: vi.fn(),
      setCombineFilms: vi.fn(),
      setSheetMaterial: vi.fn(),
    };

    const result = await applyCutProfileSelection({
      currentJob: job({ name: 'Раскрой 2709', splitByMaterial: false, combineFilms: false, sheetMaterialTypeId: 2 }),
      paramProfileId: 4,
      profiles: [profile(4, 'vacuum_table')],
      sheetOptions: [sheet(2, 'Ванна 2800x1050')],
      mutations,
    });

    expect(calls).toEqual([
      ['profile', 17, 4, 10],
      ['name', 17, 'Ванна 2709', 11],
    ]);
    expect(result.job.name).toBe('Ванна 2709');
  });

  it('renames an auto-created bath job back to Раскрой when selecting a non-vacuum profile', async () => {
    const calls: Array<[string, number, number | string | null, number]> = [];
    const mutations = {
      setProfile: vi.fn(async (jobId: number, value: number | null, version: number) => {
        calls.push(['profile', jobId, value, version]);
        return job({ name: 'Ванна 2709', version: 11, paramProfileId: value });
      }),
      setName: vi.fn(async (jobId: number, value: string, version: number) => {
        calls.push(['name', jobId, value, version]);
        return job({ name: value, version: 12, paramProfileId: 5 });
      }),
      setTextureDirection: vi.fn(),
      setRotationAllowed: vi.fn(),
      setSplitByMaterial: vi.fn(),
      setCombineFilms: vi.fn(),
      setSheetMaterial: vi.fn(),
    };

    const result = await applyCutProfileSelection({
      currentJob: job({ name: 'Ванна 2709' }),
      paramProfileId: 5,
      profiles: [profile(4, 'vacuum_table'), profile(5, 'guillotine')],
      sheetOptions: [sheet(2, 'Ванна 2800x1050')],
      mutations,
    });

    expect(calls).toEqual([
      ['profile', 17, 5, 10],
      ['name', 17, 'Раскрой 2709', 11],
    ]);
    expect(result.job.name).toBe('Раскрой 2709');
  });

  it('reports a missing bath sheet after disabling both flags', async () => {
    const mutations = {
      setProfile: vi.fn(async () => job({ version: 11, paramProfileId: 4 })),
      setTextureDirection: vi.fn(async () => job({ version: 12, paramProfileId: 4, textureDirection: 'none' })),
      setRotationAllowed: vi.fn(),
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
