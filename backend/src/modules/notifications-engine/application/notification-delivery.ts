import type { BalloonMode, NotificationChannel } from '../domain/notification-rule.types';

/**
 * Единое решение о балуне (план 2026-10-03 §2.1): уведомление получает балун, только если у правила, по которому оно
 * доставляется, включены каналы `in_app` и `balloon`; режим — свойство исчезновения правила. Без правила — без балуна.
 * Все писатели уведомлений берут решение отсюда и пишут через `PgNotificationWriteAdapter`.
 */
export function balloonFor(rule: { channels: readonly NotificationChannel[]; balloonMode: BalloonMode } | null | undefined): BalloonMode | null {
  if (!rule) return null;
  return rule.channels.includes('in_app') && rule.channels.includes('balloon') ? rule.balloonMode : null;
}
