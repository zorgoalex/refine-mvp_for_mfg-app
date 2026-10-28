/** Query parameters that only carry a one-time navigation (a link to one card): the page applies them on the way in,
 * the tab does not keep them — otherwise every later opening of the tab (click, reload, next sign-in) repeats the
 * link, e.g. the MDF board opening on an old date and warning that the card is no longer in its period. */
const ONE_TIME_PARAMS: Record<string, readonly string[]> = {
  '/mdf-work-board': ['cardKind', 'cardId'],
};

/** The path a workspace tab keeps for this location. */
export function workspaceTabPath(pathname: string, search: string): string {
  const dropped = ONE_TIME_PARAMS[pathname];
  if (!dropped || !search) return `${pathname}${search}`;
  const params = new URLSearchParams(search);
  if (!dropped.some((name) => params.has(name))) return `${pathname}${search}`;
  for (const name of dropped) params.delete(name);
  const rest = params.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
