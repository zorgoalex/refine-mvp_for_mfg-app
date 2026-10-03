import type { MyWhatsAppSend } from '../../api/myWhatsAppSendsApi';
import type { OrderSendView } from '../../api/orderSendApiTypes';
import type { BroadcastRunDetail } from '../../api/broadcastsApiTypes';
import { authSession } from '../../api/authSession';

/** Window event fired after a send command was accepted (detail: id, meta, userId). */
export const WHATSAPP_SEND_QUEUED_EVENT = 'erp:whatsapp-send-queued';

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

export function browserStorage(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

const STATE_KEY = 'whatsapp.my-sends.v3';
const MAX_TRACKED = 50;
const MAX_ANNOUNCED = 200;

/** Storage key of a user's follow state (other tabs listen to its `storage` events). */
export function followStateKey(userId: string): string {
  return `${STATE_KEY}.${userId}`;
}

/** What a followed send is: enough to ask an older backend (without /whatsapp/my-sends) about it. */
export interface SendMeta {
  kind: 'order_send' | 'calendar_send';
  orderId?: number;
  /** When following started (ms): an older backend is asked for at most LEGACY_FOLLOW_MS after it. */
  since?: number;
}

/** How long an older backend (no /whatsapp/my-sends) is asked about one send before giving up. */
export const LEGACY_FOLLOW_MS = 15 * 60_000;

/** The user and auth session a send belongs to, captured BEFORE its command was sent. */
export interface SendOwner { userId: string; session: number }

export function currentOwner(): SendOwner {
  return { userId: String(authSession.getUser()?.id ?? ''), session: authSession.getSessionGeneration() };
}

/**
 * Per-user follow state, shared by the pages and tabs of one browser:
 * `tracked` — sends whose balloon is still due (registered when the server accepted the command, before
 * any poll, or when first seen active), `meta` — what each tracked send is; `announced` — sends whose
 * balloon was shown, never again.
 */
export interface FollowState { tracked: string[]; announced: string[]; meta: Record<string, SendMeta> }

/** The page's view of the state: localStorage while it works; after a failure the page memory, for good. */
export interface FollowAccess { storage: StorageLike | null; memory: FollowState & { degraded?: boolean } }

export function emptyFollowState(): FollowState & { degraded?: boolean } {
  return { tracked: [], announced: [], meta: {} };
}

function parseState(raw: string | null): FollowState {
  try {
    const record = JSON.parse(raw ?? 'null') as Partial<FollowState> | null;
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
    const meta: Record<string, SendMeta> = {};
    for (const [id, value] of Object.entries(record?.meta ?? {})) {
      const item = value as Partial<SendMeta>;
      if (item?.kind === 'order_send' || item?.kind === 'calendar_send') {
        meta[id] = { kind: item.kind, ...(typeof item.orderId === 'number' ? { orderId: item.orderId } : {}),
          ...(typeof item.since === 'number' ? { since: item.since } : {}) };
      }
    }
    return { tracked: ids(record?.tracked), announced: ids(record?.announced), meta };
  } catch {
    return emptyFollowState();
  }
}

/** Caps both lists the same way everywhere, keeping the newest ids in a stable order. */
function capped(state: FollowState): FollowState {
  const tracked = state.tracked.slice(-MAX_TRACKED);
  return { tracked, announced: state.announced.slice(-MAX_ANNOUNCED),
    meta: Object.fromEntries(tracked.filter((id) => state.meta[id]).map((id) => [id, state.meta[id]])) };
}

/** Keeps the page memory a copy of the last successfully read or written state (used if storage fails later). */
function mirror(access: FollowAccess, state: FollowState): void {
  access.memory.tracked = state.tracked;
  access.memory.announced = state.announced;
  access.memory.meta = state.meta;
}

/** Reads the current state of this page (storage, or — after storage failed — the last good snapshot in memory). */
export function loadState(userId: string, access: FollowAccess): FollowState {
  if (!access.storage || access.memory.degraded) return access.memory;
  try {
    const state = parseState(access.storage.getItem(followStateKey(userId)));
    mirror(access, state);
    return state;
  } catch {
    access.memory.degraded = true;
    return access.memory;
  }
}

/** Saves a change; writes storage only on a real change (no storage event otherwise); on failure the memory takes over. */
export function saveState(userId: string, state: FollowState, access: FollowAccess): void {
  const next = capped(state);
  if (access.storage && !access.memory.degraded) {
    try {
      const value = JSON.stringify(next);
      if (access.storage.getItem(followStateKey(userId)) !== value) access.storage.setItem(followStateKey(userId), value);
      mirror(access, next);
      return;
    } catch {
      access.memory.degraded = true;
    }
  }
  mirror(access, next);
}

/** Whether a `storage` change of the follow state added a tracked id (only that wakes another tab). */
export function addedTrackedIds(oldValue: string | null, newValue: string | null): boolean {
  const before = new Set(parseState(oldValue).tracked);
  return parseState(newValue).tracked.some((id) => !before.has(id));
}

interface LockManagerLike { request<T>(name: string, callback: () => T | Promise<T>): Promise<T> }

/**
 * Serializes every change of a user's follow state across the tabs of the browser (Web Locks):
 * a read-modify-write in one tab never interleaves with another tab's. Without Web Locks (very old
 * browsers) the change runs unlocked — a duplicate balloon in two windows is the worst case.
 */
export async function withFollowLock<T>(userId: string, fn: () => T,
  locks: LockManagerLike | undefined = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { locks?: LockManagerLike }).locks): Promise<T> {
  if (!locks?.request) return fn();
  return locks.request(`whatsapp-my-sends.${userId}`, () => fn());
}

/** Registers a just-accepted send, so its balloon survives a reload or a send finishing before the first poll. */
export function trackSend(userId: string, id: string, meta: SendMeta, access: FollowAccess, now = Date.now()): void {
  const state = loadState(userId, access);
  if (state.announced.includes(id) || state.tracked.includes(id)) return;
  saveState(userId, { ...state, tracked: [...state.tracked, id], meta: { ...state.meta, [id]: { ...meta, since: meta.since ?? now } } }, access);
}

/**
 * Called by the order card and the calendar right after the server accepted a send. `owner` was
 * captured before the command was sent: the send is registered for THAT user (even if another user
 * signed in meanwhile), and this page is woken only if the session is still the same.
 */
export async function announceWhatsAppSendQueued(id: string, meta: SendMeta, owner: SendOwner,
  storage: StorageLike | null = browserStorage()): Promise<void> {
  if (!owner.userId) return;
  await withFollowLock(owner.userId, () => trackSend(owner.userId, id, meta, { storage, memory: emptyFollowState() })).catch(() => undefined);
  if (owner.session !== authSession.getSessionGeneration() || typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(WHATSAPP_SEND_QUEUED_EVENT, { detail: { id, meta, userId: owner.userId } }));
}

/**
 * The sends of a poll response whose balloon is due — the same set `collectFinished` would return — WITHOUT writing
 * the state: the balloons are put into the durable balloon queue first, only then marked announced (план 2026-10-03 R2-2).
 */
export function finishedDue(items: readonly MyWhatsAppSend[], userId: string, access: FollowAccess): MyWhatsAppSend[] {
  const base = loadState(userId, access);
  const announced = new Set(base.announced);
  const tracked = new Set(base.tracked.filter((id) => !announced.has(id)));
  return items.filter((item) => !item.active && tracked.has(item.id));
}

/**
 * Applies one poll response: active sends become tracked (unless already announced); a tracked send
 * that is final is marked announced FIRST and returned once. One read and one write of the state.
 */
export function collectFinished(items: readonly MyWhatsAppSend[], userId: string, access: FollowAccess): MyWhatsAppSend[] {
  const base = loadState(userId, access);
  const announced = [...base.announced];
  const announcedSet = new Set(announced);
  const tracked = base.tracked.filter((id) => !announcedSet.has(id));
  const meta = { ...base.meta };
  for (const item of items) {
    if (item.active && !announcedSet.has(item.id) && !tracked.includes(item.id)) {
      tracked.push(item.id);
      meta[item.id] = { kind: item.kind, ...(item.orderId !== null ? { orderId: item.orderId } : {}), since: Date.now() };
    }
  }
  const due = items.filter((item) => !item.active && tracked.includes(item.id));
  for (const item of due) { announced.push(item.id); announcedSet.add(item.id); tracked.splice(tracked.indexOf(item.id), 1); }
  saveState(userId, { tracked, announced, meta }, access);
  return due;
}

// ------------------------------------------------------------------ older backend (no /whatsapp/my-sends)

const ORDER_SEND_ACTIVE = new Set(['queued', 'sending']);
const RUN_ACTIVE = new Set(['preparing', 'queued', 'sending']);
const FORM_TITLES: Record<string, string> = {
  production_pdf: 'PDF для производства', order_pdf: 'PDF заказа', production_excel: 'Excel для производства', order_excel: 'Excel заказа',
};

/**
 * A card send as an older backend reports it (GET /orders/:id/whatsapp-sends lists every sender's
 * sends of the order: only the user's own are taken). No time estimate is known there.
 */
export function fromOrderSendView(view: OrderSendView, userId: string): MyWhatsAppSend | null {
  if (String(view.actor?.id ?? '') !== userId) return null;
  const recipient = view.targetKind === 'client' ? 'клиенту' : `в чат «${view.recipientLabel}»`;
  const active = ORDER_SEND_ACTIVE.has(view.state);
  return {
    kind: 'order_send', id: view.sendId, title: `Заказ #${view.orderId} → ${recipient}, ${FORM_TITLES[view.form] ?? view.form}`,
    state: view.state, active, estimatedAt: null, createdAt: view.createdAt,
    finishedAt: active ? null : view.sentAt ?? view.createdAt, errorCode: view.errorCode, cancelReason: view.cancelReason,
    orderId: view.orderId, targetDate: null,
  };
}

/**
 * An older backend could not confirm the result within LEGACY_FOLLOW_MS (no access to the order any
 * more, the send left its short history, errors): a final «not confirmed» item, announced once.
 */
export function unconfirmedItem(id: string, meta: SendMeta | undefined): MyWhatsAppSend {
  return {
    kind: meta?.kind ?? 'order_send', id,
    title: meta?.kind === 'calendar_send' ? 'Отправка из календаря' : `Заказ ${meta?.orderId ? `#${meta.orderId}` : ''}`.trim(),
    state: 'unconfirmed', active: false, estimatedAt: null, createdAt: '', finishedAt: null, errorCode: null, cancelReason: null,
    orderId: meta?.orderId ?? null, targetDate: null,
  };
}

/** A calendar send as an older backend reports it (GET /whatsapp/broadcast-runs/:runId, the user's own followed run). */
export function fromBroadcastRun(detail: BroadcastRunDetail): MyWhatsAppSend {
  const run = detail.run;
  const [year, month, day] = String(run.targetDate).split('-');
  const active = RUN_ACTIVE.has(run.state);
  return {
    kind: 'calendar_send', id: run.id, title: `Календарь, ${day}.${month}.${year} → чат`, state: run.state, active,
    estimatedAt: null, createdAt: String((run as { createdAt?: string }).createdAt ?? ''),
    finishedAt: null, errorCode: (run as { reason?: string | null }).reason ?? null, cancelReason: null, orderId: null,
    targetDate: String(run.targetDate),
  };
}

const FAILURES: Record<string, string> = {
  CLIENT_NOT_ON_WHATSAPP: 'номера клиента нет в WhatsApp',
  WAHA_REJECTED: 'WhatsApp не принял файл',
  WAHA_FILE_UNSUPPORTED: 'WhatsApp не принимает файлы такого типа',
  NO_ORDERS: 'на этот день нет заказов',
};

export interface WhatsAppBalloon { type: 'success' | 'warning' | 'error'; title: string; text: string }

/** The balloon of one finished send. */
export function balloonFor(item: MyWhatsAppSend): WhatsAppBalloon {
  switch (item.state) {
    case 'sent':
      return { type: 'success', title: 'Отправлено в WhatsApp', text: item.title };
    case 'empty':
      return { type: 'warning', title: 'Нечего отправлять', text: `${item.title} — на этот день нет заказов` };
    case 'partial':
      return { type: 'warning', title: 'Отправлено частично', text: item.title };
    case 'unknown':
      return item.errorCode === 'PARTIAL_DELIVERY'
        ? { type: 'warning', title: 'Ушла только часть изображений', text: `${item.title} — проверьте чат` }
        : { type: 'warning', title: 'Результат отправки неизвестен', text: `${item.title} — проверьте чат` };
    case 'unconfirmed':
      return { type: 'warning', title: 'Не удалось подтвердить отправку', text: `${item.title} — проверьте чат` };
    case 'cancelled':
      if (item.cancelReason === 'manual') {
        return { type: 'warning', title: item.cancelledByOther ? 'Отменено администратором' : 'Отправка отменена', text: item.title };
      }
      return { type: 'warning', title: 'Отправка не состоялась', text: item.title };
    case 'expired':
    case 'skipped':
      return { type: 'warning', title: 'Отправка не состоялась', text: item.title };
    default:
      return { type: 'error', title: 'Не отправлено', text: `${item.title}${item.errorCode && FAILURES[item.errorCode] ? ` — ${FAILURES[item.errorCode]}` : ''}` };
  }
}

/** More finished at once than this — one summary balloon instead of a stack (mass cancel, a long queue). */
export const BALLOON_SUMMARY_FROM = 4;

/**
 * The balloons of the sends that finished since the last poll: one each, or — when many finished at
 * once (the queue was disabled, a long queue left) — a single summary.
 */
export function balloonsFor(items: readonly MyWhatsAppSend[]): Array<WhatsAppBalloon & { key: string }> {
  if (items.length < BALLOON_SUMMARY_FROM) return items.map((item) => ({ ...balloonFor(item), key: `whatsapp-send-${item.id}` }));
  const sent = items.filter((item) => item.state === 'sent').length;
  const cancelled = items.filter((item) => item.state === 'cancelled').length;
  const other = items.length - sent - cancelled;
  const parts = [sent ? `отправлено ${sent}` : '', cancelled ? `отменено ${cancelled}` : '', other ? `не состоялось или под вопросом ${other}` : '']
    .filter(Boolean).join(', ');
  return [{
    key: `whatsapp-send-summary-${items.map((item) => item.id).sort().join('.').slice(0, 64)}`,
    type: other || cancelled ? 'warning' : 'success',
    title: `WhatsApp: завершено ${items.length} отправок`,
    text: `${parts}. Подробности — в истории отправок.`,
  }];
}

/** «≈ 12:45» in Almaty time; «сейчас» when the estimate is within a minute. */
export function estimateText(estimatedAt: string | null, now: Date = new Date()): string {
  if (!estimatedAt) return '';
  const at = new Date(estimatedAt);
  if (Number.isNaN(at.getTime())) return '';
  if (at.getTime() - now.getTime() <= 60_000) return 'сейчас';
  return `≈ ${new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Almaty', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)}`;
}

/** Poll often while something is pending, rarely after recent activity, otherwise only on demand. */
export function nextPollDelay(items: readonly MyWhatsAppSend[], lastActivityAt: number, now = Date.now()): number | null {
  if (items.some((item) => item.active)) return 15_000;
  if (now - lastActivityAt < 30 * 60_000) return 60_000;
  return null;
}
