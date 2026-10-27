import type { ScanCandidate } from '../../api/types/labelsApi.types';

/**
 * «NewLine»: последние открытые по скану детали — в этом браузере, у каждого пользователя свои.
 * Хранится сама находка, поэтому повторное касание идёт тем же путём, что и новый скан.
 */
export const SCAN_RECENT_LIMIT = 5;
const KEY = (userId: number | string | null) => `scanRecent:${userId ?? 'anon'}`;

function isCandidate(value: unknown): value is ScanCandidate {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<ScanCandidate>;
  return typeof c.detailId === 'number' && typeof c.orderId === 'number' && typeof c.orderName === 'string';
}

export function loadScanRecent(userId: number | string | null): ScanCandidate[] {
  try {
    const raw = globalThis.localStorage?.getItem(KEY(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isCandidate).slice(0, SCAN_RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Ставит деталь первой; та же деталь не повторяется. Возвращает новый список. */
export function rememberScan(userId: number | string | null, candidate: ScanCandidate): ScanCandidate[] {
  const next = [candidate, ...loadScanRecent(userId).filter((item) => item.detailId !== candidate.detailId)]
    .slice(0, SCAN_RECENT_LIMIT);
  try {
    globalThis.localStorage?.setItem(KEY(userId), JSON.stringify(next));
  } catch {
    /* приватный режим/квота — список просто не сохранится */
  }
  return next;
}
