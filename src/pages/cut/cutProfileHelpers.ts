import type { CutParamProfile, CutSettingRow } from '../../api/cutConfigApi';
import { resolveRuntimeDefaultProfile } from '../configuration/components/cutConfigHelpers';

/** Display label for a job's cut profile. Pass the FULL profile list (active +
 *  inactive).
 *  - `null` (unset) → neutral "По умолчанию". We DO NOT name a specific profile
 *    here: backend `NULL` means "use the job's create-time params snapshot", which
 *    can differ from the CURRENT default profile after the default changes —
 *    naming the current default would misrepresent what calculate will use.
 *  - chosen profile that is the current runtime default → "name (по умолчанию)".
 *  - chosen active profile → "name".
 *  - chosen but inactive → "name (неактивен)".
 *  - id absent from the list → stable "Профиль #id". */
export function resolveProfileLabel(
  paramProfileId: number | null,
  profiles: CutParamProfile[],
  settings: CutSettingRow[],
): string {
  if (paramProfileId === null) {
    return 'По умолчанию';
  }
  const runtimeDefault = resolveRuntimeDefaultProfile(profiles, settings);
  const chosen = profiles.find((p) => p.cutParamProfileId === paramProfileId);
  if (!chosen) {
    return `Профиль #${paramProfileId}`;
  }
  if (chosen.cutParamProfileId === runtimeDefault?.cutParamProfileId) {
    return `${chosen.name} (по умолчанию)`;
  }
  return chosen.isActive ? chosen.name : `${chosen.name} (неактивен)`;
}

export function formatArea(area: number): string {
  return (Number.isFinite(area) ? area : 0).toFixed(2);
}
