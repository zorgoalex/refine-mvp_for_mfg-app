import type { FreecutParams } from '../application/cut-freecut-mapping';

export interface ResolveCalcParamsInput {
  profileId: number | null;
  /** create-time default snapshot from cut_job.params (may be null/empty) */
  jobParams: FreecutParams | null;
  /** params for the chosen active profile; null only when profileId is null
   *  (a null with profileId set is a caller bug — see resolveCalcParams) */
  profileParams: FreecutParams | null;
  /** runtime default params */
  defaultParams: FreecutParams;
}

export function resolveCalcParams(input: ResolveCalcParamsInput): FreecutParams {
  if (input.profileId !== null) {
    // A chosen profile MUST resolve to real params. calculate rejects an
    // inactive/missing profile with 422 BEFORE calling this, so a null here is a
    // caller bug — fail loudly rather than silently cutting with default params.
    if (input.profileParams === null) {
      throw new Error('resolveCalcParams: profileParams is required when profileId is set');
    }
    return input.profileParams;
  }
  if (input.jobParams && Object.keys(input.jobParams).length > 0) {
    return input.jobParams;
  }
  return input.defaultParams;
}
