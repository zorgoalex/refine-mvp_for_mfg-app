import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../../api/apiError';
import { authSession } from '../../api/authSession';
import { broadcastsApi } from '../../api/broadcastsApi';
import { myWhatsAppSendsApi, type MyWhatsAppSend } from '../../api/myWhatsAppSendsApi';
import { orderSendApi } from '../../api/orderSendApi';
import { useBalloonCenter } from '../../notifications/balloons/BalloonCenter';
import type { LocalBalloon } from '../../notifications/balloons/balloonCenterModel';
import {
  WHATSAPP_SEND_QUEUED_EVENT, addedTrackedIds, balloonsFor, browserStorage, collectFinished, emptyFollowState, finishedDue, followStateKey,
  LEGACY_FOLLOW_MS, fromBroadcastRun, fromOrderSendView, loadState, nextPollDelay, trackSend, unconfirmedItem, withFollowLock,
  type FollowAccess, type SendMeta, type WhatsAppBalloon,
} from './myWhatsAppSendsModel';

/** A WhatsApp balloon (one send or a summary) for the app balloon center (15 s, like before). */
export function toLocalBalloon(balloon: WhatsAppBalloon & { key: string }): LocalBalloon {
  return { key: balloon.key, kind: balloon.type, title: balloon.title, text: balloon.text, mode: 'auto' };
}

/** Balloons are shown by the app balloon center (BalloonCenterProvider); nothing to render here any more. */
const NO_CONTEXT_HOLDER = React.createElement(React.Fragment);
/** Повтор постановки балунов, не принятых очередью центра. */
const UNACCEPTED_RETRY_MS = 30_000;

/**
 * An older backend has no /whatsapp/my-sends: ask its existing endpoints about the followed sends
 * (card sends by order history, calendar sends by run). Unanswered ids are simply asked again later.
 */
async function legacyItems(ids: readonly string[], meta: Record<string, SendMeta>, userId: string, now = Date.now()): Promise<MyWhatsAppSend[]> {
  const items: MyWhatsAppSend[] = [];
  const answered = new Set<string>();
  const orders = new Map<number, string[]>();
  for (const id of ids) {
    const info = meta[id];
    if (info?.kind === 'order_send' && info.orderId) orders.set(info.orderId, [...(orders.get(info.orderId) ?? []), id]);
    if (info?.kind === 'calendar_send') {
      try {
        const run = fromBroadcastRun(await broadcastsApi.run(id));
        items.push(run);
        if (!run.active) answered.add(id);
      } catch { /* asked again on the next poll, until the deadline below */ }
    }
  }
  for (const [orderId, wanted] of orders) {
    try {
      const sends = (await orderSendApi.list(orderId)).sends;
      for (const send of sends) {
        const mapped = wanted.includes(send.sendId) ? fromOrderSendView(send, userId) : null;
        if (mapped) { items.push(mapped); if (!mapped.active) answered.add(mapped.id); }
      }
    } catch { /* 403, network…: asked again on the next poll, until the deadline below */ }
  }
  // Not confirmed within the deadline (no access to the order any more, out of the short history,
  // errors): a final «not confirmed», announced once — then the background requests stop.
  for (const id of ids) {
    const since = meta[id]?.since;
    if (!answered.has(id) && (since === undefined || now - since > LEGACY_FOLLOW_MS)) {
      const at = items.findIndex((entry) => entry.id === id);
      if (at >= 0) items.splice(at, 1);
      items.push(unconfirmedItem(id, meta[id]));
    }
  }
  return items;
}

/**
 * The current user's own WhatsApp sends (order card and calendar): follows them while something is
 * pending and announces each finished one with a balloon through the app balloon center (15 s). One request at a time; a response of an earlier request or
 * of another session is dropped. Mounted once by WhatsAppSendsProvider, which renders `contextHolder`.
 */
export function useMyWhatsAppSends(): { items: MyWhatsAppSend[]; refresh: () => void; contextHolder: React.ReactElement;
  /** false = an older backend without /whatsapp/my-sends: the followed sends are asked through its old endpoints. */
  supported: boolean | null } {
  // Re-render on every session change (login, logout, another user) even without a React-driven update.
  const session = useSyncExternalStore(authSession.subscribe, authSession.getSessionGeneration, authSession.getSessionGeneration);
  const user = authSession.getUser();
  const userId = user?.id ? String(user.id) : '';
  // Any signed-in user: the backend returns only his own sends (an author keeps cancelling his waiting ones
  // even after a right was taken away).
  const allowed = Boolean(userId);
  // Центр балунов — через ref: смена значения контекста не перезапускает слежение (и не зацикливает эффект).
  const balloonCenter = useBalloonCenter();
  const centerRef = useRef(balloonCenter);
  centerRef.current = balloonCenter;
  const contextHolder = NO_CONTEXT_HOLDER;
  const [items, setItems] = useState<MyWhatsAppSend[]>([]);
  const [supported, setSupported] = useState<boolean | null>(null);
  const access = useRef<FollowAccess>({ storage: browserStorage(), memory: emptyFollowState() });
  const legacy = useRef(false);
  const lastActivity = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const running = useRef(false);
  const again = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    if (!allowed || !mounted.current) return;
    if (running.current) { again.current = true; return; }
    running.current = true;
    const gen = generation.current;
    const sessionAtStart = authSession.getSessionGeneration();
    // Valid only while this hook generation AND the auth session are the ones the request started with.
    const current = () => gen === generation.current && sessionAtStart === authSession.getSessionGeneration();
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    try {
      const followed = loadState(userId, access.current);
      let next: MyWhatsAppSend[] | null = null;
      let unaccepted = false;
      if (!legacy.current) {
        try {
          next = (await myWhatsAppSendsApi.list(followed.tracked)).items;
          if (current()) setSupported(true);
        } catch (error) {
          // A stale error of a previous session never changes this session's mode.
          if (!current()) return;
          if (error instanceof ApiError && error.status === 404) {
            // An older backend: from now on (this session) ask its existing endpoints about the followed sends.
            legacy.current = true;
            setSupported(false);
          }
          next = null;
        }
      }
      if (legacy.current) next = await legacyItems(followed.tracked, followed.meta, userId);
      if (!current()) return; // the session changed (logout / another user) meanwhile
      if (next) {
        const items = next;
        setItems(items);
        if (items.some((item) => item.active)) lastActivity.current = Date.now();
        // The session is re-checked INSIDE the lock, before any write. Balloons of finished sends go into the durable
        // queue of the balloon center FIRST (idempotent by key), only then the sends are marked announced: closing the
        // tab in between re-queues them (no-op), never loses them (план 2026-10-03 R2-2).
        await withFollowLock(userId, async () => {
          if (!current()) return;
          unaccepted = false;
          const pending = finishedDue(items, userId, access.current);
          const center = centerRef.current;
          // Балуны завершившихся (по одному или один сводный — balloonsFor); ключ → отправки, которые он объявляет.
          const balloons = balloonsFor(pending);
          const idsOf = new Map(balloons.map((balloon) => [balloon.key,
            balloons.length === 1 && pending.length > 1 ? pending.map((due) => due.id) : pending.filter((due) => `whatsapp-send-${due.id}` === balloon.key).map((due) => due.id)]));
          let acceptedKeys = new Set<string>();
          if (pending.length > 0 && center) {
            try {
              acceptedKeys = new Set(await center.enqueueLocal(userId, balloons.map(toLocalBalloon)));
            } catch {
              acceptedKeys = new Set(); // очередь недоступна — отправки остаются отслеживаемыми, повтор на следующем опросе
            }
          }
          const accepted = new Set([...acceptedKeys].flatMap((key) => idsOf.get(key) ?? []));
          // Объявленными становятся только принятые очередью (R1-3 code review): непринятые остаются в tracked.
          const keep = items.filter((item) => item.active || !pending.some((due) => due.id === item.id) || accepted.has(item.id));
          unaccepted = pending.some((due) => !accepted.has(due.id));
          if (current()) collectFinished(keep, userId, access.current);
        }).catch(() => undefined);
        if (!current()) return;
      }
      const pending = loadState(userId, access.current).tracked.length > 0;
      const base = legacy.current ? (pending ? 15_000 : null) : next ? nextPollDelay(next, lastActivity.current) : 60_000;
      // Завершённые отправки, чей балун очередь центра не приняла, повторяются сами (R2-2 code review), пока не примет.
      const delay = unaccepted ? Math.min(base ?? UNACCEPTED_RETRY_MS, UNACCEPTED_RETRY_MS) : base;
      if (delay !== null && !again.current) timer.current = setTimeout(() => void loadRef.current(), delay);
    } finally {
      running.current = false;
      // A request asked for meanwhile runs now through the CURRENT callback (never the previous session's closure).
      if (again.current) { again.current = false; void loadRef.current(); }
    }
  }, [allowed, userId]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    // A new session (logout, another user): close the previous user's balloons and forget the state.
    mounted.current = true;
    generation.current += 1;
    setItems([]);
    access.current = { storage: browserStorage(), memory: emptyFollowState() };
    again.current = false;
    // Backend support is detected again for every session.
    legacy.current = false;
    setSupported(null);
    if (!allowed) return undefined;
    void load();
    const onQueued = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; meta?: SendMeta; userId?: string }>).detail;
      lastActivity.current = Date.now();
      // Registered in THIS page's state too (it may run on memory after a storage failure). The session,
      // the hook generation and the page state are captured now and re-checked INSIDE the lock.
      const gen = generation.current;
      const sessionNow = authSession.getSessionGeneration();
      const pageAccess = access.current;
      const register = detail?.id && detail.meta && detail.userId === userId
        ? withFollowLock(userId, () => {
          if (gen !== generation.current || sessionNow !== authSession.getSessionGeneration() || pageAccess !== access.current) return;
          trackSend(userId, detail.id as string, detail.meta as SendMeta, pageAccess);
        })
        : Promise.resolve();
      void register.catch(() => undefined).then(() => loadRef.current());
    };
    // Another tab of this user added a followed send (it may close before the send ends): wake up.
    const onStorage = (event: StorageEvent) => {
      if (event.key === followStateKey(userId) && addedTrackedIds(event.oldValue, event.newValue)) void loadRef.current();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener(WHATSAPP_SEND_QUEUED_EVENT, onQueued);
      window.addEventListener('storage', onStorage);
    }
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (typeof window !== 'undefined') {
        window.removeEventListener(WHATSAPP_SEND_QUEUED_EVENT, onQueued);
        window.removeEventListener('storage', onStorage);
      }
      if (timer.current) clearTimeout(timer.current);
    };
  }, [allowed, userId, load, session]);

  return { items, refresh: () => void loadRef.current(), contextHolder, supported };
}
