export type ScanAction = 'open-order' | 'show-info';
const KEY = (userId: number | string | null) => `scanDefaultAction:${userId ?? 'anon'}`;
const VALID: ReadonlySet<string> = new Set(['open-order', 'show-info']);

export function getScanAction(userId: number | string | null): ScanAction | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY(userId));
    return raw && VALID.has(raw) ? (raw as ScanAction) : null;
  } catch {
    return null;
  }
}

export function setScanAction(userId: number | string | null, action: ScanAction): void {
  try {
    globalThis.localStorage?.setItem(KEY(userId), action);
  } catch {
    /* приватный режим/квота — настройка просто не сохранится */
  }
}
