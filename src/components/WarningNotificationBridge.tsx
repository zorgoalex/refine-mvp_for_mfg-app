import { useEffect } from 'react';
import { notification } from 'antd';
import { cncTelegramApi } from '../api/cncTelegramApi';
import { authSession } from '../api/authSession';
import { featureFlags } from '../config/featureFlags';
import { useNotificationStore } from '../stores/notificationStore';
import { authStorage } from '../utils/auth';
import { can } from '../utils/permissions';
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
      if (!authSession.getAccessToken() || !can('audit.technical.view', user)) {
        previous = null;
        notification.destroy(TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY);
        return;
      }

      checking = true;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const response = await cncTelegramApi.workerTechnicalLogs({
          dateFrom: today,
          dateTo: today,
          page: 1,
          pageSize: 1,
        });
        if (stopped) return;
        const next = telegramWorkerHealthState(response.health.latestHeartbeatAt);
        const transition = telegramWorkerHealthTransition(previous, next);
        previous = next;
        if (transition === 'stale') {
          notification.error({
            key: TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY,
            message: 'Telegram Worker не отвечает',
            description: 'Heartbeat отсутствует больше 90 секунд. Проверьте CNC Telegram worker.',
            duration: 0,
          });
        } else if (transition === 'recovered') {
          notification.success({
            key: TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY,
            message: 'Telegram Worker восстановлен',
            description: 'Heartbeat снова поступает.',
            duration: 5,
          });
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
      notification.destroy(TELEGRAM_WORKER_HEALTH_NOTIFICATION_KEY);
    };
  }, []);

  return null;
}
