import type { CutParamProfile, CutSettingRow } from '../../api/cutConfigApi';
import { resolveRuntimeDefaultProfile } from '../configuration/components/cutConfigHelpers';

/** Effective cut-profile params for a job: the chosen profile's params when set,
 *  otherwise the runtime default profile's params. `null` when neither resolves
 *  (no profiles / no default). Used to decide preview orientation (vacuum). */
export function resolveJobProfileParams(
  paramProfileId: number | null,
  profiles: CutParamProfile[],
  settings: CutSettingRow[],
): Record<string, unknown> | null {
  if (paramProfileId !== null) {
    const chosen = profiles.find((p) => p.cutParamProfileId === paramProfileId);
    if (chosen) return chosen.params;
  }
  const def = resolveRuntimeDefaultProfile(profiles, settings);
  return def ? def.params : null;
}

/** True when the effective profile uses the vacuum-table layout. */
export function isVacuumLayout(params: Record<string, unknown> | null): boolean {
  return !!params && params.layout_mode === 'vacuum_table';
}

/** Whether to rotate a sheet preview 90° to landscape (long side horizontal).
 *  For vacuum-table jobs a portrait sheet (height > width) is rotated; an
 *  already-landscape sheet is left as-is. Non-vacuum jobs are never rotated. */
export function shouldRotateLandscape(widthMm: number, heightMm: number, vacuum: boolean): boolean {
  return vacuum && heightMm > widthMm;
}

/** Rounded mm side label, e.g. "2800 мм". */
export function formatSheetSide(mm: number): string {
  return `${Math.round(mm)} мм`;
}

/** Displayed (post-rotation) mm extents of a sheet: [horizontalMm, verticalMm].
 *  When rotated 90°, the sheet's height becomes the horizontal extent. */
export function displayedSheetExtents(
  widthMm: number,
  heightMm: number,
  rotate: boolean,
): { horizontalMm: number; verticalMm: number } {
  return rotate
    ? { horizontalMm: heightMm, verticalMm: widthMm }
    : { horizontalMm: widthMm, verticalMm: heightMm };
}
