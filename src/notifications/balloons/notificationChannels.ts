import type { BalloonMode, NotificationChannel } from '../../api/types/notificationRulesApi.types';

/**
 * Каналы правила уведомлений (план 2026-10-03 §2.2) — общая логика компонента `NotificationChannelsField`:
 * балун показывает in_app-уведомление, поэтому без «В приложении» его нет; снятие «В приложении» снимает и балун.
 */
export function normalizeChannels(next: readonly NotificationChannel[], previous: readonly NotificationChannel[]): NotificationChannel[] {
  const unique = Array.from(new Set(next));
  const balloonJustAdded = unique.includes('balloon') && !previous.includes('balloon');
  // Балун отмечен без «В приложении» — добавить «В приложении» (иначе выбор балуна ни на что не влиял бы).
  if (balloonJustAdded && !unique.includes('in_app')) unique.unshift('in_app');
  // «В приложении» снято — балун тоже.
  if (!unique.includes('in_app')) return unique.filter((channel) => channel !== 'balloon');
  return unique;
}

export const BALLOON_MODE_LABELS: Record<BalloonMode, string> = {
  auto: 'Исчезает через 15 секунд',
  persistent: 'Не исчезает — закрыть крестиком',
};

/** Подпись канала в таблице правил (балун — с режимом). */
export function channelLabel(channel: NotificationChannel, balloonMode: BalloonMode | undefined): string {
  if (channel === 'in_app') return 'В приложении';
  if (channel === 'telegram') return 'Telegram';
  return balloonMode === 'persistent' ? 'Балун · до крестика' : 'Балун · 15 с';
}
