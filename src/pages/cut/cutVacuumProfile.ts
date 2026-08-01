import type { CutParamProfile } from '../../api/cutConfigApi';
import type { CutJobDto, CutSheetTypeOption } from '../../api/types/cutApi.types';

export function isVacuumTableProfile(
  profileId: number | null,
  profiles: CutParamProfile[],
): boolean {
  return profiles.some(
    (profile) =>
      profile.cutParamProfileId === profileId
      && profile.params?.layout_mode === 'vacuum_table',
  );
}

export function firstBathSheetMaterialId(options: CutSheetTypeOption[]): number | null {
  return options.find((option) =>
    option.name.trimStart().toLocaleLowerCase('ru-RU').startsWith('ванна'),
  )?.sheetMaterialTypeId ?? null;
}

interface CutProfileMutations {
  setProfile(cutJobId: number, profileId: number | null, version: number): Promise<CutJobDto>;
  setSplitByMaterial(cutJobId: number, value: boolean, version: number): Promise<CutJobDto>;
  setCombineFilms(cutJobId: number, value: boolean, version: number): Promise<CutJobDto>;
  setSheetMaterial(cutJobId: number, sheetMaterialTypeId: number | null, version: number): Promise<CutJobDto>;
}

export async function applyCutProfileSelection(input: {
  currentJob: CutJobDto;
  paramProfileId: number | null;
  profiles: CutParamProfile[];
  sheetOptions: CutSheetTypeOption[];
  mutations: CutProfileMutations;
  onUpdated?: (job: CutJobDto) => void;
}): Promise<{ job: CutJobDto; bathSheetMissing: boolean }> {
  const {
    currentJob,
    paramProfileId,
    profiles,
    sheetOptions,
    mutations,
    onUpdated,
  } = input;
  const publish = (updated: CutJobDto): CutJobDto => {
    onUpdated?.(updated);
    return updated;
  };

  let updated = publish(await mutations.setProfile(
    currentJob.cutJobId,
    paramProfileId,
    currentJob.version,
  ));
  if (!isVacuumTableProfile(paramProfileId, profiles)) {
    return { job: updated, bathSheetMissing: false };
  }

  if (updated.splitByMaterial) {
    updated = publish(await mutations.setSplitByMaterial(
      updated.cutJobId,
      false,
      updated.version,
    ));
  }
  if (updated.combineFilms) {
    updated = publish(await mutations.setCombineFilms(
      updated.cutJobId,
      false,
      updated.version,
    ));
  }

  const bathSheetMaterialId = firstBathSheetMaterialId(sheetOptions);
  if (bathSheetMaterialId === null) {
    return { job: updated, bathSheetMissing: true };
  }
  if (updated.sheetMaterialTypeId !== bathSheetMaterialId) {
    updated = publish(await mutations.setSheetMaterial(
      updated.cutJobId,
      bathSheetMaterialId,
      updated.version,
    ));
  }

  return { job: updated, bathSheetMissing: false };
}
