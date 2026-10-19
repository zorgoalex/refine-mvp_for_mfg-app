import type {
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
}

export function policyToFormValues(policy: OnecAlertPolicy): OnecAlertPolicyFormValues {
  return {
    importance: policy.importance,
    recipientRoleCodes: [...policy.recipientRoleCodes],
    recipientUserIds: [...policy.recipientUserIds],
    repeatMinutes: policy.repeatMinutes,
    notifyResolved: policy.notifyResolved,
  };
}

/**
 * PATCH body: the form edits importance, recipients, repeat and recovery; fields of the external channels (delay,
 * quiet hours) are not on the form yet and are sent back unchanged.
 */
export function buildPolicyUpdate(policy: OnecAlertPolicy, values: OnecAlertPolicyFormValues): OnecAlertPolicyUpdate {
  return {
    importance: values.importance,
    recipientRoleCodes: [...new Set(values.recipientRoleCodes)].sort(),
    recipientUserIds: [...new Set(values.recipientUserIds)].sort((a, b) => a - b),
    externalChannels: [...policy.externalChannels],
    delayMinutes: policy.delayMinutes,
    repeatMinutes: values.repeatMinutes,
    notifyResolved: values.notifyResolved,
    quietHours: policy.quietHours,
    criticalIgnoresQuietHours: policy.criticalIgnoresQuietHours,
  };
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
    if (group.filteredOut.length > 0) {
      warnings.push({
        type: 'warning',
        message: `«${group.label}»: не получат ${group.filteredOut.map((user) => user.username).join(', ')} — нет права «Просмотр интеграции 1С» или учётная запись отключена.`,
      });
    }
  }
  return warnings;
}
