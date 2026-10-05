/**
 * Центр балунов (план 2026-10-03 §2.2) — чистая логика, общая для всех источников балунов:
 * - места: на экране вкладки не больше MAX_VISIBLE; место занято, пока балун открыт (auto — 15 с, persistent — до
 *   крестика); места для серверных балунов резервируются ДО запроса claim (R3-2) и не отдаются локальной очереди;
 * - сохраняемая очередь локальных балунов (WhatsApp и т. п.): `localStorage` на пользователя под Web Lock; элемент
 *   уходит из очереди только при показе; ключ идемпотентен (повторная постановка показанного или ждущего — no-op).
 */

export const MAX_VISIBLE = 5;
export const AUTO_SECONDS = 15;
const QUEUE_KEY = 'balloons.queue.v1';
const SHOWN_TTL_MS = 24 * 60 * 60_000;
const MAX_QUEUE = 100;

export type BalloonMode = 'auto' | 'persistent';
export type BalloonKind = 'info' | 'success' | 'warning' | 'error';

export interface LocalBalloon {
  /** Идемпотентный ключ источника, например `whatsapp-send-<id>`. */
  key: string;
  kind: BalloonKind;
  title: string;
  text: string;
  mode: BalloonMode;
}

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** Ждущий балун очереди; `leasedBy`/`leasedAt` — вкладка, которая его рисует (до подтверждения показа). */
export type QueuedBalloon = LocalBalloon & { leasedBy?: string; leasedAt?: number };
interface QueueState { items: QueuedBalloon[]; shown: Record<string, number> }

/** Аренда локального балуна вкладкой (как у серверных, план 2026-10-03 R3-1): не подтверждён за 2 мин — снова доступен. */
export const LOCAL_LEASE_MS = 2 * 60_000;
export const MAX_QUEUE_ITEMS = MAX_QUEUE;

export function queueKey(userId: string): string {
  return `${QUEUE_KEY}.${userId}`;
}

function parse(raw: string | null, now: number): QueueState {
  try {
    const value = JSON.parse(raw ?? 'null') as Partial<QueueState> | null;
    const items = Array.isArray(value?.items) ? value!.items.filter((item): item is QueuedBalloon =>
      Boolean(item) && typeof item.key === 'string' && typeof item.title === 'string' && typeof item.text === 'string'
      && (item.mode === 'auto' || item.mode === 'persistent')
      && ['info', 'success', 'warning', 'error'].includes(item.kind)) : [];
    const shown: Record<string, number> = {};
    for (const [key, at] of Object.entries(value?.shown ?? {})) {
      if (typeof at === 'number' && now - at < SHOWN_TTL_MS) shown[key] = at;
    }
    return { items, shown };
  } catch {
    return { items: [], shown: {} };
  }
}

/**
 * Поставить в очередь (R1-3 code review: без вытеснения). Возвращает ключи, которые очередь ПРИНЯЛА (новые, уже
 * ждущие, уже показанные); при полной очереди новые не принимаются — источник оставляет их у себя и повторит позже.
 * Ошибки хранилища пробрасываются — вызывающий решает (центр переходит на очередь в памяти).
 */
export function enqueue(userId: string, balloons: readonly LocalBalloon[], storage: StorageLike, now = Date.now()): string[] {
  const state = parse(storage.getItem(queueKey(userId)), now);
  const waiting = new Set(state.items.map((item) => item.key));
  const accepted: string[] = [];
  let changed = false;
  for (const balloon of balloons) {
    if (waiting.has(balloon.key) || state.shown[balloon.key] !== undefined) { accepted.push(balloon.key); continue; }
    if (state.items.length >= MAX_QUEUE) continue;
    state.items.push({ ...balloon });
    waiting.add(balloon.key);
    accepted.push(balloon.key);
    changed = true;
  }
  if (changed) storage.setItem(queueKey(userId), JSON.stringify(state));
  return accepted;
}

/**
 * Арендовать до `count` балунов для показа этой вкладкой (FIFO; свои незавершённые аренды — первыми, чужие — после
 * истечения). Из очереди не удаляются: удаляет `confirmShown` после фактической отрисовки (R1-1 code review).
 */
export function leaseForDisplay(userId: string, count: number, token: string, storage: StorageLike, now = Date.now()): LocalBalloon[] {
  if (count <= 0) return [];
  const state = parse(storage.getItem(queueKey(userId)), now);
  const free = (item: QueuedBalloon) => !item.leasedBy || item.leasedBy === token || now - (item.leasedAt ?? 0) >= LOCAL_LEASE_MS;
  const ordered = [...state.items.filter((item) => item.leasedBy === token), ...state.items.filter((item) => item.leasedBy !== token && free(item))];
  const taken = ordered.slice(0, count);
  if (taken.length === 0) return [];
  const keys = new Set(taken.map((item) => item.key));
  state.items = state.items.map((item) => (keys.has(item.key) ? { ...item, leasedBy: token, leasedAt: now } : item));
  storage.setItem(queueKey(userId), JSON.stringify(state));
  return taken.map(({ leasedBy: _by, leasedAt: _at, ...balloon }) => balloon);
}

/** Показ состоялся (тело балуна смонтировано): убрать из очереди, запомнить показанным. */
export function confirmShown(userId: string, keys: readonly string[], storage: StorageLike, now = Date.now()): void {
  if (keys.length === 0) return;
  const state = parse(storage.getItem(queueKey(userId)), now);
  const done = new Set(keys);
  state.items = state.items.filter((item) => !done.has(item.key));
  for (const key of keys) state.shown[key] = now;
  storage.setItem(queueKey(userId), JSON.stringify(state));
}

/** Снимок ждущих балунов без записи (запасной путь, когда запись аренды в хранилище не удаётся). */
export function readQueue(userId: string, storage: StorageLike, now = Date.now()): LocalBalloon[] {
  return parse(storage.getItem(queueKey(userId)), now).items.map(({ leasedBy: _by, leasedAt: _at, ...balloon }) => balloon);
}

export function pendingCount(userId: string, storage: StorageLike, now = Date.now()): number {
  return parse(storage.getItem(queueKey(userId)), now).items.length;
}

/** Места вкладки: открытые балуны + резерв под запрос claim. */
export class BalloonSlots {
  private readonly open = new Set<string>();
  private reservedCount = 0;

  constructor(private readonly max = MAX_VISIBLE) {}

  free(): number {
    return Math.max(0, this.max - this.open.size - this.reservedCount);
  }

  /** Зарезервировать до `count` мест (синхронно); вернуть, сколько получилось. */
  reserve(count: number): number {
    const granted = Math.min(Math.max(0, count), this.free());
    this.reservedCount += granted;
    return granted;
  }

  /** Отдать неиспользованный резерв. */
  release(count: number): void {
    this.reservedCount = Math.max(0, this.reservedCount - Math.max(0, count));
  }

  /** Открыть балун: из резерва (`fromReserve`) или из свободных мест; false — места нет. */
  openBalloon(key: string, fromReserve = false): boolean {
    if (this.open.has(key)) return false;
    if (fromReserve) {
      if (this.reservedCount <= 0) return false;
      this.reservedCount -= 1;
    } else if (this.free() <= 0) {
      return false;
    }
    this.open.add(key);
    return true;
  }

  close(key: string): void {
    this.open.delete(key);
  }

  isOpen(key: string): boolean {
    return this.open.has(key);
  }

  get openCount(): number {
    return this.open.size;
  }

  get reserved(): number {
    return this.reservedCount;
  }

  reset(): void {
    this.open.clear();
    this.reservedCount = 0;
  }
}

export interface LockManagerLike { request<T>(name: string, callback: () => T | Promise<T>): Promise<T> }

/** Межвкладочная блокировка очереди балунов пользователя (Web Locks); без них — без блокировки (показ в каждой вкладке). */
export async function withBalloonLock<T>(userId: string, fn: () => T | Promise<T>,
  locks: LockManagerLike | undefined = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: LockManagerLike }).locks): Promise<T> {
  if (!locks?.request) return fn();
  return locks.request(`balloons.${userId}`, () => fn());
}

/** Длительность antd-балуна: auto — 15 с, persistent — 0 (только крестик). */
export function durationFor(mode: BalloonMode): number {
  return mode === 'persistent' ? 0 : AUTO_SECONDS;
}

/** Токен вкладки для аренды серверных балунов: переживает перезагрузку вкладки (sessionStorage), свой на пользователя. */
export function tabToken(userId: string, session: StorageLike | null, makeId: () => string): string {
  const key = `balloons.tab-token.${userId}`;
  try {
    const existing = session?.getItem(key);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const token = makeId();
    session?.setItem(key, token);
    return token;
  } catch {
    return makeId();
  }
}
