/** Rounded mm side label, e.g. "2800 мм". */
export function formatSheetSide(mm: number): string {
  return `${Math.round(mm)} мм`;
}

/** Displayed mm extents of a sheet: [horizontal, vertical]. In landscape the
 *  sheet's height is the horizontal extent (used to label the preview sides). */
export function displayedSheetExtents(
  widthMm: number,
  heightMm: number,
  landscape: boolean,
): { horizontalMm: number; verticalMm: number } {
  return landscape
    ? { horizontalMm: heightMm, verticalMm: widthMm }
    : { horizontalMm: widthMm, verticalMm: heightMm };
}

/** localStorage key for a user's per-job sheet-orientation preference. */
export function sheetOrientationKey(userId: string, cutJobId: number): string {
  return `cut:sheet-orientation:${userId}:${cutJobId}`;
}

/** Parse a stored orientation value. Default (absent / unknown) = portrait. */
export function parseStoredPortrait(raw: string | null): boolean {
  return raw !== 'landscape';
}

/** Read the per-user per-job portrait preference (default portrait = true). */
export function loadSheetOrientationPortrait(userId: string, cutJobId: number): boolean {
  try {
    return parseStoredPortrait(localStorage.getItem(sheetOrientationKey(userId, cutJobId)));
  } catch {
    return true;
  }
}

/** Persist the per-user per-job portrait preference. */
export function saveSheetOrientationPortrait(userId: string, cutJobId: number, portrait: boolean): void {
  try {
    localStorage.setItem(sheetOrientationKey(userId, cutJobId), portrait ? 'portrait' : 'landscape');
  } catch {
    // ignore storage failures (private mode / quota)
  }
}
