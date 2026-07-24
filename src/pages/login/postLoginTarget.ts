export function resolvePostLoginTarget(
  locationSearch: string,
  origin: string,
): string {
  const rawTarget = new URLSearchParams(locationSearch).get('to');
  if (!rawTarget || !rawTarget.startsWith('/') || rawTarget.startsWith('//')) {
    return '/';
  }

  try {
    const target = new URL(rawTarget, origin);
    if (target.origin !== origin) return '/';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return '/';
  }
}
