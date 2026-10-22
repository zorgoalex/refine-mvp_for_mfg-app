import type {
  WhatsAppNotificationChannelDto,
  WhatsAppNotificationDeliveryDto,
  WhatsAppNotificationLevel,
  WhatsAppNotificationState,
} from '../../../api/types/whatsappApi.types';

/** «Конфигурация» → «Уведомления» → «Канал WhatsApp»: подписи журнала доставок. */

export const WHATSAPP_NOTIFICATION_STATE_VIEW: Record<WhatsAppNotificationState, { label: string; color: string }> = {
  queued: { label: 'В очереди', color: 'blue' },
  sending: { label: 'Отправляется', color: 'processing' },
  sent: { label: 'Отправлено', color: 'green' },
  failed: { label: 'Ошибка', color: 'red' },
  unknown: { label: 'Требует проверки', color: 'orange' },
  cancelled: { label: 'Отменено', color: 'default' },
  skipped: { label: 'Пропущено', color: 'default' },
};

export const WHATSAPP_NOTIFICATION_LEVEL_VIEW: Record<WhatsAppNotificationLevel, { label: string; color: string }> = {
  info: { label: 'Информация', color: 'blue' },
  warning: { label: 'Предупреждение', color: 'orange' },
  error: { label: 'Ошибка', color: 'red' },
};

const REASONS: Record<string, string> = {
  WHATSAPP_DISABLED: 'WhatsApp выключен или этот сервер не отправляет сообщения',
  USER_INACTIVE: 'Пользователь не найден или отключён',
  PERMISSION_MISSING: 'У пользователя нет нужного права',
  NO_WORK_PHONE: 'У сотрудника нет основного рабочего телефона',
  cancelled_by_source: 'Отменено модулем, который поставил сообщение',
  expired: 'Истёк срок жизни сообщения',
  delivery_gap: 'Поставлено до перезапуска сервера и не отправлялось',
  permission_revoked: 'Право отозвано до отправки',
  recipient_changed: 'Рабочий телефон сменился до отправки',
  recipient_removed: 'Пользователь отключён до отправки',
  EMPLOYEE_NOT_ON_WHATSAPP: 'Номер сотрудника не зарегистрирован в WhatsApp',
  CHAT_NOT_FOUND: 'Группа недоступна подключённому аккаунту',
  WAHA_REJECTED: 'WhatsApp отклонил сообщение',
  WAHA_UNAVAILABLE: 'WhatsApp временно недоступен, повтор позже',
  WAHA_PROVIDER_ERROR: 'Ошибка WhatsApp, повтор позже',
  WAHA_UNCERTAIN: 'Неизвестно, ушло ли сообщение; повторно не отправляется',
  PROVIDER_ACK_MISSING_ID: 'WhatsApp принял сообщение без номера; повторно не отправляется',
  INTENT_STALE: 'Отправка прервалась; ушло ли сообщение, неизвестно',
  PAYLOAD_MISSING: 'Текст или адрес сообщения не сохранились',
};

/** Понятная причина; неизвестный код показывается как есть. */
export function whatsappNotificationReason(reason: string | null): string | null {
  if (!reason) return null;
  return REASONS[reason] ?? reason;
}

const SOURCES: Record<string, string> = {
  onec_alert: 'Оповещения 1С',
};

export function whatsappNotificationSource(sourceType: string): string {
  return SOURCES[sourceType] ?? sourceType;
}

export const WHATSAPP_NOTIFICATION_SOURCE_OPTIONS = Object.entries(SOURCES).map(([value, label]) => ({ value, label }));

/** Пользователь: ФИО сотрудника, логин и маска номера; что известно. */
export function whatsappNotificationUserLabel(recipient: Extract<WhatsAppNotificationDeliveryDto['recipient'], { kind: 'user' }>): string {
  const name = recipient.employeeName ?? recipient.username ?? (recipient.userId === null ? 'Пользователь' : `Пользователь #${recipient.userId}`);
  const login = recipient.employeeName && recipient.username ? ` (${recipient.username})` : '';
  return `${name}${login}`;
}

export type ChannelHealth = { tone: 'success' | 'warning' | 'info'; title: string; description: string };

/** Состояние канала одной строкой над журналом. */
export function whatsappNotificationChannelHealth(channel: WhatsAppNotificationChannelDto): ChannelHealth {
  if (!channel.enabled) {
    return { tone: 'info', title: 'WhatsApp выключен', description: 'Новые уведомления сразу записываются как «Пропущено» и не накапливаются.' };
  }
  if (!channel.deliverable) {
    return { tone: 'info', title: 'Этот сервер не отправляет уведомления',
      description: 'Отправку ведёт другой процесс или она выключена; новые уведомления записываются как «Пропущено».' };
  }
  if (channel.paused) {
    return { tone: 'warning', title: 'Рассылки остановлены',
      description: 'Уведомления ждут в очереди; те, у которых истечёт срок, будут отменены. Возобновить — в «Рассылке сообщений».' };
  }
  return { tone: 'success', title: 'Канал работает', description: 'Уведомления отправляются по одному, сначала ошибки, потом предупреждения.' };
}
