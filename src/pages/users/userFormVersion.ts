/**
 * Row version of an open user form (transitional users protocol): the version it was loaded with, advanced only by
 * this form's own confirmed commands. A command sent with `expectedVersion = v` and confirmed by the server changed
 * exactly version v, so the row is now v + 1 and nothing newer was masked. Responses are applied monotonically: a
 * late response of an older command never lowers the version.
 */
export function formRowVersion(loaded: number | null | undefined, own: number | undefined): number | undefined {
  const values = [loaded, own].filter((value): value is number => typeof value === 'number');
  return values.length ? Math.max(...values) : undefined;
}

export function advanceOwnVersion(
  own: number | undefined,
  sent: number | undefined,
  returned: number | undefined,
): number | undefined {
  // Without a sent version the server did not check the form against the row: its new version says nothing about
  // the fields of this form, so the form keeps its version (and a later save meets a newer row as a conflict).
  if (typeof sent !== 'number' || typeof returned !== 'number' || returned !== sent + 1) return own;
  return typeof own === 'number' ? Math.max(own, returned) : returned;
}
