import { useEffect } from 'react';
import { cncTelegramApi } from '../api/cncTelegramApi';
import { authSession } from '../api/authSession';
import { featureFlags } from '../config/featureFlags';
import { useNotificationStore } from '../stores/notificationStore';
import { authStorage } from '../utils/auth';
import { canAll } from '../utils/permissions';
import { observeUserWarnings } from '../utils/warningNotificationCapture';

export const TELEGRAM_WORKER_HEARTBEAT_STALE_MS = 90_000;
export const TELEGRAM_WORKER_HEALTH_POLL_MS = 30_000;
const TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY = 'telegram-worker-health';

export type TelegramWorkerHealthState = 'healthy' | 'stale';

export function telegramWorkerHealthState(
  latestHeartbeatAt: string | null,
  nowMs = Date.now(),
): TelegramWorkerHealthState {
  if (!latestHeartbeatAt) return 'stale';
  const heartbeatMs = Date.parse(latestHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return 'stale';
  return nowMs - heartbeatMs > TELEGRAM_WORKER_HEARTBEAT_STALE_MS ? 'stale' : 'healthy';
}

export function telegramWorkerHealthTransition(
  previous: TelegramWorkerHealthState | null,
  next: TelegramWorkerHealthState,
): 'stale' | 'recovered' | null {
  if (next === 'stale' && previous !== 'stale') return 'stale';
  if (next === 'healthy' && previous === 'stale') return 'recovered';
  return null;
}

export function canReceiveTelegramWorkerHealthNotification(
  user: Parameters<typeof canAll>[1],
): boolean {
  return canAll(['cut.manage', 'org.view'], user);
}

export function WarningNotificationBridge() {
  useEffect(() => {
    if (!document.body) return;

    return observeUserWarnings(document.body, (message) => {
      const user = authStorage.getUser();
      if (!user?.id) return;

      useNotificationStore
        .getState()
        .addNotification(message, 'warning', { userId: user.id });
    });
  }, []);

  useEffect(() => {
    if (!featureFlags.cncTelegram) return;

    let stopped = false;
    let checking = false;
    let previous: TelegramWorkerHealthState | null = null;

    const check = async () => {
      if (stopped || checking || document.visibilityState !== 'visible') return;
      const user = authSession.getUser();
      if (!authSession.getAccessToken() || !user?.id || !canReceiveTelegramWorkerHealthNotification(user)) {
        previous = null;
        return;
      }

      checking = true;
      try {
        const response = await cncTelegramApi.workerHealth();
        if (stopped) return;
        const next = telegramWorkerHealthState(response.latestHeartbeatAt);
        const transition = telegramWorkerHealthTransition(previous, next);
        previous = next;
        if (transition === 'stale') {
          addBellNotificationOnce(
            user.id,
            `${TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY}:stale:${response.latestHeartbeatAt ?? 'missing'}`,
            'Telegram Worker не отвечает: heartbeat отсутствует больше 90 секунд. Проверьте CNC Telegram worker.',
            'error',
          );
        } else if (transition === 'recovered') {
          addBellNotificationOnce(
            user.id,
            `${TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY}:recovered:${response.latestHeartbeatAt ?? 'missing'}`,
            'Telegram Worker восстановлен: heartbeat снова поступает.',
            'info',
          );
        }
      } catch {
        // Не смешиваем недоступность backend/API с состоянием отдельного worker.
      } finally {
        checking = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    const timer = window.setInterval(() => void check(), TELEGRAM_WORKER_HEALTH_POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  return null;
}

export function addBellNotificationOnce(
  userId: string,
  dedupeMarker: string,
  message: string,
  level: 'info' | 'error',
): void {
  const store = useNotificationStore.getState();
  store.addNotification(message, level, { userId, dedupeKey: dedupeMarker });
}
