/** Shared by the relay and the assignment CLI: the same policy from the same variables ('*' = everyone). */
export function assignmentPolicy(
  enabled: boolean,
  rawCohort: string,
  releaseAssignedById: string | number | null,
): { enabled: boolean; cohort: ReadonlySet<string> | null; releaseAssignedById: string | null } {
  const raw = rawCohort.trim();
  const release = String(releaseAssignedById ?? '').trim();
  return {
    enabled,
    cohort: raw === '*' ? null : new Set(raw.split(',').map((id) => id.trim()).filter(Boolean)),
    releaseAssignedById: /^[1-9][0-9]*$/.test(release) ? release : null,
  };
}
