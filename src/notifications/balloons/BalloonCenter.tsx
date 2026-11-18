import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { notification } from 'antd';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/apiError';
import { authSession } from '../../api/authSession';
import { notificationsApi } from '../../api/notificationsApi';
import type { BackendNotificationDto } from '../../api/types/notificationApi.types';
import {
  BalloonSlots, MAX_QUEUE_ITEMS, closesOnBodyClick, confirmShown, durationFor, enqueue, leaseForDisplay, readQueue, tabToken, withBalloonLock,
  type BalloonKind, type BalloonMode, type LocalBalloon, type StorageLike,
} from './balloonCenterModel';
import { NOTIFICATIONS_CHANGED_EVENT } from './notificationEvents';
import { startNotificationSync } from './notificationSync';

/** Сколько открытых балунов вкладка сообщает серверу для проверки замены (≤ 5 на экране, лимит API 20). */
const MAX_OPEN_REPORTED = 20;

/** CSS-класс балуна центра (оформление — styles/app.css). */
export const BALLOON_CLASS_NAME = 'app-balloon';
/** Критичный обязательный балун (оповещения 1С) — красная полоса слева, `.app-balloon--critical` в styles/app.css. */
export const BALLOON_CRITICAL_CLASS_NAME = 'app-balloon--critical';

interface BalloonCenterApi {
  /**
   * Поставить балуны источника в очередь пользователя (идемпотентно по ключу) и показать, когда будет место.
   * Возвращает ПРИНЯТЫЕ ключи: непринятые (очередь полна) источник оставляет у себя и повторит позже.
   */
  enqueueLocal(userId: string, balloons: readonly LocalBalloon[]): Promise<string[]>;
}

const BalloonCenterContext = createContext<BalloonCenterApi | null>(null);

function localStore(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
function sessionStore(): StorageLike | null {
  try { return typeof window === 'undefined' ? null : window.sessionStorage; } catch { return null; }
}
const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
const randomId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID()
  : '00000000-0000-4000-8000-000000000000'.replace(/0/g, () => Math.floor(Math.random() * 16).toString(16)));

function serverKind(level: BackendNotificationDto['level']): BalloonKind {
  return level === 'error' ? 'error' : level === 'warning' ? 'warning' : 'info';
}

/** Ссылка сущности уведомления (как в карточках приложения); нет — клик только отмечает прочитанным. */
export function entityPath(item: Pick<BackendNotificationDto, 'entityType' | 'entityId'>): string | null {
  if (item.entityType === 'order' && item.entityId && /^\d+$/.test(item.entityId)) return `/orders/show/${item.entityId}`;
  // Оповещения интеграции 1С (план 2026-10-19) — экран «Интеграция 1С».
  if (item.entityType === 'onec_alert_dispatch') return '/onec';
  return null;
}

/** Тело балуна: сообщает о фактической отрисовке (R1-1 code review) — только после этого показ подтверждается. */
const BalloonBody: React.FC<{ text: string; onShown: () => void }> = ({ text, onShown }) => {
  const shown = useRef(onShown);
  useEffect(() => { shown.current(); }, []);
  return <>{text}</>;
};

/**
 * Состояние одной сессии центра (R1-2 code review): места, резерв, флаги и очередь в памяти принадлежат поколению;
 * ответы прежней сессии меняют только своё (уже мёртвое) состояние.
 */
export class CenterSession {
  readonly slots = new BalloonSlots();
  pumping = false;
  again = false;
  alive = true;
  serverSupported = true;
  /** Очередь в памяти — если localStorage недоступен или бросает (R1-4 code review). */
  memory: LocalBalloon[] = [];
  /** Локальные ключи, показанные этой сессией любым путём (хранилище или память) — повторно не открываются. */
  memoryShown = new Set<string>();
  /** Ключи, чьё тело балуна фактически смонтировано (R2-1 code review): повторный ack — только для них. */
  mounted = new Set<string>();
  /** Открытые балуны сервера: ключ → id уведомления и слот (свежий балун слота заменяет прежний, 18.11.2026). */
  serverOpen = new Map<string, { id: string; slot: string | null }>();
  /** Backend понимает слоты (openNotificationIds, limit 0); старый отвечает 422 — тогда не слать. */
  slotsSupported = true;
  constructor(readonly userId: string, readonly token: string) {}
}

/**
 * Единый центр балунов приложения (план 2026-10-03 §2.2): один экземпляр antd `notification`, не больше 5 балунов
 * на экране вкладки, persistent закрывается только крестиком/кликом. Источники:
 * - уведомления сервера — аренда `POST /notifications/balloons/claim` ровно под зарезервированные места; `ack` —
 *   только после фактической отрисовки; опрос раз в 60 с при видимой вкладке, при возврате и после закрытия балуна;
 * - локальные (WhatsApp) — сохраняемая очередь `enqueueLocal` (аренда вкладкой, подтверждение после отрисовки).
 */
export const BalloonCenterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const sessionGeneration = useSyncExternalStore(authSession.subscribe, authSession.getSessionGeneration, authSession.getSessionGeneration);
  const userId = authSession.getUser()?.id ? String(authSession.getUser()!.id) : '';
  const [api, contextHolder] = notification.useNotification();
  const navigate = useNavigate();
  const stateRef = useRef<CenterSession | null>(null);

  /** Закрыть балун сервера, заменённый свежим балуном его слота; освободившееся место заполнит следующий проход. */
  const closeServerBalloon = useCallback((st: CenterSession, key: string) => {
    if (!st.serverOpen.has(key) && !st.slots.isOpen(key)) return;
    api.destroy(key);
    st.slots.close(key);
    st.mounted.delete(key);
    st.serverOpen.delete(key);
    st.again = true;
  }, [api]);

  const open = useCallback((st: CenterSession, input: {
    key: string; kind: BalloonKind; title: string; text: string; mode: BalloonMode; fromReserve: boolean;
    onShown: () => void; onClick?: () => void;
  }): boolean => {
    if (!st.alive || !st.slots.openBalloon(input.key, input.fromReserve)) return false;
    const closed = () => {
      if (!st.alive) return;
      st.slots.close(input.key);
      st.mounted.delete(input.key);
      st.serverOpen.delete(input.key);
      void pumpRef.current();
    };
    const shown = () => { st.mounted.add(input.key); input.onShown(); };
    api[input.kind]({
      key: input.key, message: input.title, description: <BalloonBody text={input.text} onShown={shown} />,
      // Вид балуна (мельче текст, серый контур, светло-голубой фон) — `.app-balloon` в styles/app.css.
      className: input.mode === 'mandatory' && input.kind === 'error' ? `${BALLOON_CLASS_NAME} ${BALLOON_CRITICAL_CLASS_NAME}` : BALLOON_CLASS_NAME,
      placement: 'bottomRight', duration: durationFor(input.mode), style: input.onClick ? { cursor: 'pointer' } : undefined,
      onClose: closed,
      // Обязательный балун клик по телу не закрывает — только крестик (план 2026-10-19 §2.7).
      onClick: input.onClick
        ? () => {
          if (closesOnBodyClick(input.mode)) { api.destroy(input.key); closed(); }
          input.onClick!();
        }
        : undefined,
    });
    return true;
  }, [api]);

  const pump = useCallback(async () => {
    const st = stateRef.current;
    if (!st || !st.alive) return;
    if (st.pumping) { st.again = true; return; }
    st.pumping = true;
    try {
      // 1. Локальные балуны — только в свободные (не зарезервированные) места.
      const storage = localStore();
      if (storage && st.slots.free() > 0) {
        try {
          await withBalloonLock(st.userId, () => {
            if (!st.alive) return;
            for (const balloon of leaseForDisplay(st.userId, st.slots.free(), st.token, storage)) {
              // Уже показан этой сессией (например, из очереди в памяти) — только подтвердить в хранилище (R3-1).
              if (st.memoryShown.has(balloon.key)) { confirmShown(st.userId, [balloon.key], storage); continue; }
              if (st.slots.isOpen(balloon.key)) continue;
              open(st, { ...balloon, fromReserve: false, onShown: () => {
                st.memoryShown.add(balloon.key);
                void withBalloonLock(st.userId, () => confirmShown(st.userId, [balloon.key], storage)).catch(() => undefined);
              } });
            }
          });
        } catch {
          // Запись аренды не удалась (квота) — показать ждущие из снимка через очередь в памяти (R2-3 code review);
          // дедупликация во вкладке — по ключам памяти и уже показанным.
          try {
            for (const balloon of readQueue(st.userId, storage)) {
              if (st.memoryShown.has(balloon.key) || st.slots.isOpen(balloon.key) || st.memory.some((item) => item.key === balloon.key)) continue;
              st.memory.push(balloon);
            }
          } catch { /* чтение тоже недоступно — остаётся только очередь в памяти */ }
        }
      }
      // Очередь в памяти: уже показанные (любым путём) и уже открытые копии удаляются/пропускаются — ключ показывается
      // этой сессией один раз (R3-1 code review).
      st.memory = st.memory.filter((balloon) => !st.memoryShown.has(balloon.key));
      for (const balloon of [...st.memory]) {
        if (!st.alive || st.slots.free() <= 0) break;
        if (st.slots.isOpen(balloon.key)) continue;
        const opened = open(st, { ...balloon, fromReserve: false, onShown: () => {
          st.memoryShown.add(balloon.key);
          if (storage) void withBalloonLock(st.userId, () => confirmShown(st.userId, [balloon.key], storage)).catch(() => undefined);
        } });
        if (opened) st.memory = st.memory.filter((item) => item.key !== balloon.key);
      }
      // 2. Уведомления сервера — резерв мест ДО запроса, один запрос в полёте на сессию (R3-2). Открытые балуны
      // передаются серверу: он назовёт заменённые свежим балуном их слота — они закрываются (и без свободных мест).
      if (!st.alive || !st.serverSupported || !isVisible()) return;
      const openIds = st.slotsSupported ? [...st.serverOpen.values()].map((entry) => entry.id).slice(0, MAX_OPEN_REPORTED) : [];
      const reserved = st.slots.reserve(st.slots.free());
      if (reserved === 0 && openIds.length === 0) return;
      try {
        const { items, superseded } = await notificationsApi.claimBalloons({
          token: st.token, limit: reserved, ...(openIds.length ? { openNotificationIds: openIds } : {}),
        });
        if (!st.alive) return;
        for (const id of superseded ?? []) closeServerBalloon(st, `notification-${id}`);
        for (const item of items) {
          const key = `notification-${item.notificationId}`;
          // Свежий балун слота заменяет открытый прежний (не копятся: запрос пользователя 18.11.2026).
          const slot = item.balloonSlot ?? null;
          if (slot) {
            for (const [openKey, entry] of [...st.serverOpen]) if (entry.slot === slot && openKey !== key) closeServerBalloon(st, openKey);
          }
          const ack = () => {
            if (!st.alive) return;
            if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
            // Потерянный ack не теряет балун: аренда вернётся этой вкладке, тело смонтируется — ack повторится.
            void notificationsApi.ackBalloons({ token: st.token, notificationIds: [item.notificationId] }).catch(() => undefined);
          };
          // Уже открыт (повтор аренды): подтвердить снова, только если тело действительно смонтировано; иначе ack
          // сделает само тело при монтировании.
          if (st.slots.isOpen(key)) { if (st.mounted.has(key)) ack(); continue; }
          if (!item.balloonMode) continue;
          const path = entityPath(item);
          const opened = open(st, {
            key, kind: serverKind(item.level), title: item.title ?? 'Уведомление', text: item.message, mode: item.balloonMode,
            fromReserve: true, onShown: ack,
            onClick: () => {
              void notificationsApi.markRead(item.notificationId).catch(() => undefined)
                .then(() => { if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT)); });
              if (path) navigate(path);
            },
          });
          if (opened) st.serverOpen.set(key, { id: item.notificationId, slot });
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) st.serverSupported = false;
        // Старый backend не знает слотов (строгая схема → 422): дальше без них, следующий запрос — как раньше.
        else if (error instanceof ApiError && error.status === 422 && st.slotsSupported) { st.slotsSupported = false; st.again = true; }
      } finally {
        st.slots.release(st.slots.reserved);
      }
    } finally {
      st.pumping = false;
      if (st.again && st.alive) { st.again = false; void pumpRef.current(); }
    }
  }, [closeServerBalloon, navigate, open]);
  const pumpRef = useRef(pump);
  pumpRef.current = pump;

  useEffect(() => {
    // Новая сессия (выход, другой пользователь): закрыть балуны прежней, начать с чистого состояния.
    api.destroy();
    if (!userId) { stateRef.current = null; return undefined; }
    const st = new CenterSession(userId, tabToken(userId, sessionStore(), randomId));
    stateRef.current = st;
    void pumpRef.current();
    // The server says when this user's notifications change (stream, plan part B): the bell list and the balloons
    // re-sync then; without the stream — every minute, as before (notificationSync.ts).
    const sync = startNotificationSync({
      openStream: (signal) => notificationsApi.openStream(signal),
      onSync: () => {
        void pumpRef.current();
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
      },
      isVisible,
    });
    return () => {
      st.alive = false;
      if (stateRef.current === st) stateRef.current = null;
      sync.stop();
      api.destroy();
    };
  }, [api, userId, sessionGeneration]);

  const enqueueLocal = useCallback(async (owner: string, balloons: readonly LocalBalloon[]): Promise<string[]> => {
    if (!owner || balloons.length === 0) return [];
    const storage = localStore();
    if (storage) {
      try {
        const accepted = await withBalloonLock(owner, () => enqueue(owner, balloons, storage));
        if (owner === stateRef.current?.userId) void pumpRef.current();
        return accepted;
      } catch {
        // Хранилище недоступно/переполнено — очередь в памяти текущей сессии (ниже).
      }
    }
    const st = stateRef.current;
    if (!st || st.userId !== owner) return [];
    const accepted: string[] = [];
    for (const balloon of balloons) {
      if (st.memoryShown.has(balloon.key) || st.memory.some((item) => item.key === balloon.key)) { accepted.push(balloon.key); continue; }
      if (st.memory.length >= MAX_QUEUE_ITEMS) continue;
      st.memory.push(balloon);
      accepted.push(balloon.key);
    }
    void pumpRef.current();
    return accepted;
  }, []);

  const value = useMemo<BalloonCenterApi>(() => ({ enqueueLocal }), [enqueueLocal]);
  return (
    <BalloonCenterContext.Provider value={value}>
      {contextHolder}
      {children}
    </BalloonCenterContext.Provider>
  );
};

/** Доступ источников к центру балунов; вне провайдера — null (источник сам решает, что делать). */
export function useBalloonCenter(): BalloonCenterApi | null {
  return useContext(BalloonCenterContext);
}
