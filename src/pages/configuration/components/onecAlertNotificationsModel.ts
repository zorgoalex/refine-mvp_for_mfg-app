import type {
  OnecAlertExternalChannel,
  OnecAlertExternalRecipient,
  OnecAlertGroupView,
  OnecAlertImportance,
  OnecAlertNotificationsOverview,
  OnecAlertPolicy,
  OnecAlertPolicyImportance,
  OnecAlertPolicyUpdate,
  OnecAlertStage,
} from '../../onec/onecAlertNotificationsApi';

/** «Конфигурация → Оповещения 1С»: pure helpers of the tab (labels, form ↔ policy, warnings). */

export const IMPORTANCE_OPTIONS: { value: OnecAlertPolicyImportance; label: string }[] = [
  { value: 'auto', label: 'По оповещению' },
  { value: 'critical', label: 'Критично' },
  { value: 'important', label: 'Важно' },
  { value: 'info', label: 'Информация' },
];

export const IMPORTANCE_LABELS: Record<OnecAlertImportance, string> = {
  critical: 'Критично',
  important: 'Важно',
  info: 'Информация',
};

export const STAGE_LABELS: Record<OnecAlertStage, string> = {
  opened: 'Открыто',
  escalated: 'Стало критичным',
  reminder: 'Напоминание',
  resolved: 'Восстановлено',
  digest: 'Сводка при включении',
};

export const REPEAT_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: 'Не повторять' },
  { value: 30, label: 'Каждые 30 минут' },
  { value: 60, label: 'Каждый час' },
  { value: 120, label: 'Каждые 2 часа' },
  { value: 240, label: 'Каждые 4 часа' },
  { value: 480, label: 'Каждые 8 часов' },
  { value: 1440, label: 'Раз в сутки' },
];

export const FALLBACK_LABELS: Record<number, string> = {
  1: 'выбранные получатели',
  2: 'запасные: все с правом «Управление интеграцией 1С»',
  3: 'запасные: суперадминистраторы',
};

export const DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Сразу' },
  { value: 5, label: 'Через 5 минут' },
  { value: 10, label: 'Через 10 минут' },
  { value: 15, label: 'Через 15 минут' },
  { value: 30, label: 'Через 30 минут' },
  { value: 60, label: 'Через час' },
];

/** Quiet hours, Asia/Almaty; the current value is kept even when it is not a preset. */
export const QUIET_HOURS_PRESETS: string[] = ['22:00-08:00', '23:00-08:00', '21:00-09:00', '20:00-08:00'];

export function quietHoursOptions(current: string | null): { value: string; label: string }[] {
  const values = [...QUIET_HOURS_PRESETS];
  if (current && !values.includes(current)) values.unshift(current);
  return [{ value: 'none', label: 'Нет — отправлять в любое время' }, ...values.map((value) => ({ value, label: `С ${value.replace('-', ' до ')}` }))];
}

const WHATSAPP_STATE_LABELS: Record<string, string> = {
  queued: 'в очереди',
  sending: 'отправляется',
  sent: 'отправлено',
  failed: 'не доставлено',
  unknown: 'неизвестно',
  cancelled: 'отменено',
  skipped: 'не отправлено',
};

const WHATSAPP_REASON_LABELS: Record<string, string> = {
  WHATSAPP_DISABLED: 'WhatsApp на сервере выключен',
  USER_INACTIVE: 'учётная запись отключена',
  PERMISSION_MISSING: 'нет права «Просмотр интеграции 1С»',
  NO_WORK_PHONE: 'нет рабочего телефона',
  RESOLVED_BEFORE_DELAY: 'закрылось до конца задержки',
  RESOLVED_BEFORE_SEND: 'закрылось до отправки',
  ENQUEUE_FAILED: 'сбой постановки в очередь',
  cancelled_by_source: 'оповещение закрылось или настройка изменилась',
  delivery_gap: 'сервер перезапускался',
  expired: 'истёк срок',
  permission_revoked: 'право отозвано',
  recipient_changed: 'получатель изменился',
  recipient_removed: 'получатель удалён',
  EMPLOYEE_NOT_ON_WHATSAPP: 'номера нет в WhatsApp',
  CHAT_NOT_FOUND: 'чат не найден',
  WAHA_REJECTED: 'WhatsApp отклонил сообщение',
};

export function whatsappStateLabel(state: string | null, reason: string | null): string {
  const base = state ? WHATSAPP_STATE_LABELS[state] ?? state : 'в очереди';
  const why = reason ? WHATSAPP_REASON_LABELS[reason] ?? reason : '';
  return why ? `${base}: ${why}` : base;
}

/** Tag color of a WhatsApp row by its state. */
export function whatsappStateColor(row: Pick<OnecAlertExternalRecipient, 'state'>): string | undefined {
  if (row.state === 'sent') return 'green';
  if (row.state === 'failed' || row.state === 'unknown') return 'red';
  if (row.state === 'skipped' || row.state === 'cancelled') return 'default';
  return 'blue';
}

/** Channels of a policy as table tags (the bell and the balloon are always there). */
export function channelLabels(policy: Pick<OnecAlertPolicy, 'externalChannels' | 'whatsappChatName' | 'whatsappChatId'>): string[] {
  const labels = ['Колокольчик', 'Окно с крестиком'];
  if (policy.externalChannels.includes('whatsapp')) labels.push('WhatsApp лично');
  if (policy.externalChannels.includes('whatsapp_chat')) labels.push(`WhatsApp-чат «${policy.whatsappChatName ?? policy.whatsappChatId ?? '?'}»`);
  return labels;
}

export function importanceLabel(value: OnecAlertPolicyImportance): string {
  return IMPORTANCE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

export function repeatLabel(value: number | null): string {
  return REPEAT_OPTIONS.find((option) => option.value === value)?.label ?? `Каждые ${value} мин`;
}

export interface OnecAlertPolicyFormValues {
  importance: OnecAlertPolicyImportance;
  recipientRoleCodes: string[];
  recipientUserIds: number[];
  repeatMinutes: number | null;
  notifyResolved: boolean;
  whatsappPersonal: boolean;
  whatsappChat: boolean;
  whatsappChatId: string | null;
  whatsappChatName: string | null;
  delayMinutes: number;
  quietHours: string | null;
  criticalIgnoresQuietHours: boolean;
}

export function policyToFormValues(policy: OnecAlertPolicy): OnecAlertPolicyFormValues {
  return {
    importance: policy.importance,
    recipientRoleCodes: [...policy.recipientRoleCodes],
    recipientUserIds: [...policy.recipientUserIds],
    repeatMinutes: policy.repeatMinutes,
    notifyResolved: policy.notifyResolved,
    whatsappPersonal: policy.externalChannels.includes('whatsapp'),
    whatsappChat: policy.externalChannels.includes('whatsapp_chat'),
    whatsappChatId: policy.whatsappChatId,
    whatsappChatName: policy.whatsappChatName,
    delayMinutes: policy.delayMinutes,
    quietHours: policy.quietHours,
    criticalIgnoresQuietHours: policy.criticalIgnoresQuietHours,
  };
}

/** A form value the backend would refuse, in words; null — can be saved. */
export function formProblem(values: OnecAlertPolicyFormValues): string | null {
  if (values.whatsappChat && !values.whatsappChatId) return 'Выберите чат WhatsApp или снимите отметку «В чат WhatsApp»';
  return null;
}

/**
 * PATCH body. Channels the form does not edit (Telegram) are kept. The chat is sent only when it changed: the backend
 * keeps it when the fields are absent, and changing it needs the right to manage WhatsApp.
 */
export function buildPolicyUpdate(policy: OnecAlertPolicy, values: OnecAlertPolicyFormValues): OnecAlertPolicyUpdate {
  const externalChannels: OnecAlertExternalChannel[] = policy.externalChannels.filter((channel) => channel !== 'whatsapp' && channel !== 'whatsapp_chat');
  if (values.whatsappPersonal) externalChannels.push('whatsapp');
  if (values.whatsappChat) externalChannels.push('whatsapp_chat');
  const update: OnecAlertPolicyUpdate = {
    importance: values.importance,
    recipientRoleCodes: [...new Set(values.recipientRoleCodes)].sort(),
    recipientUserIds: [...new Set(values.recipientUserIds)].sort((a, b) => a - b),
    externalChannels: externalChannels.sort(),
    delayMinutes: values.delayMinutes,
    repeatMinutes: values.repeatMinutes,
    notifyResolved: values.notifyResolved,
    quietHours: values.quietHours,
    criticalIgnoresQuietHours: values.criticalIgnoresQuietHours,
  };
  if ((values.whatsappChatId ?? null) !== (policy.whatsappChatId ?? null)) {
    update.whatsappChatId = values.whatsappChatId;
    update.whatsappChatName = values.whatsappChatId ? values.whatsappChatName : null;
  }
  return update;
}

/** Who gets this group's alerts now, in words. */
export function recipientsSummary(group: OnecAlertGroupView): string {
  if (!group.recipients) return 'Некому доставить';
  const names = group.recipients.users.map((user) => user.name);
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` и ещё ${names.length - 5}` : '');
  return `${shown} (${FALLBACK_LABELS[group.recipients.fallbackLevel] ?? ''})`;
}

export interface OnecAlertWarning {
  type: 'error' | 'warning' | 'info';
  message: string;
}

/** Warnings above the table: flag, dispatcher, nobody to deliver to, configured users filtered out. */
export function overviewWarnings(overview: OnecAlertNotificationsOverview): OnecAlertWarning[] {
  const warnings: OnecAlertWarning[] = [];
  if (!overview.flagEnabled) {
    warnings.push({ type: 'warning', message: 'Рассылка оповещений 1С выключена на сервере — настройки сохраняются, но уведомления не отправляются.' });
  } else if (overview.monitorOwner !== 'in_process') {
    warnings.push({ type: 'error', message: 'На этом сервере не работает монитор 1С — оповещения отправлять некому.' });
  }
  if (overview.lastTickError) {
    warnings.push({ type: 'error', message: `Последний проход рассылки завершился ошибкой: ${overview.lastTickError}` });
  }
  const nobody = overview.groups.filter((group) => !group.recipients);
  if (nobody.length > 0) {
    warnings.push({ type: 'error', message: `Неисправность: оповещения 1С некому доставить (${nobody.map((group) => group.label).join(', ')}).` });
  }
  for (const group of overview.groups) {
    if ((group.withoutWorkPhone ?? []).length > 0) {
      warnings.push({
        type: 'warning',
        message: `«${group.label}»: в WhatsApp лично не получат ${(group.withoutWorkPhone ?? []).map((user) => user.name).join(', ')} — у сотрудника нет рабочего телефона.`,
      });
    }
    if (group.filteredOut.length > 0) {
      warnings.push({
        type: 'warning',
        message: `«${group.label}»: не получат ${group.filteredOut.map((user) => user.username).join(', ')} — нет права «Просмотр интеграции 1С» или учётная запись отключена.`,
      });
    }
  }
  return warnings;
}
