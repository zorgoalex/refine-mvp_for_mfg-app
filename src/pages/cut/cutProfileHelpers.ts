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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns a Russian tooltip string explaining what each cut profile layout does.
 *  Reads `params.layout_mode` and `params.vacuum.direction`.
 *  Unknown / absent layout_mode falls back to the guillotine text. */
export function describeCutProfile(params: Record<string, unknown>): string {
  const mode = params.layout_mode;

  if (mode === 'vacuum_table') {
    const vacuum = params.vacuum;
    const direction = isPlainObject(vacuum) ? vacuum.direction : undefined;
    if (direction === 'width') {
      return 'Вакуумный стол (вдоль): запрещает поворот; сторона «высота» из списка деталей идёт вдоль длинной стороны листа. Если ширина не помещается поперёк, деталь разворачивается с предупреждением.';
    }
    if (direction === 'height') {
      return 'Вакуумный стол (поперёк): запрещает поворот; сторона «ширина» из списка деталей идёт вдоль длинной стороны листа. Если высота не помещается поперёк, деталь разворачивается с предупреждением.';
    }
    // optimal or missing direction → авто
    return 'Вакуумный стол (авто): игнорирует текстуру плёнки, разрешает поворот деталей на 90° и сначала заполняет физическую ширину стола, затем длину.';
  }

  if (mode === 'nested') {
    return 'Вложенный раскрой: детали плотно вкладываются друг в друга.';
  }

  // guillotine + unknown/absent layout_mode
  return 'Гильотинный рез: сквозные прямые резы (полосами).';
}
