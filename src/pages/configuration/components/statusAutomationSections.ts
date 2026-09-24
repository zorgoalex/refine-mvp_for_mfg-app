import type { StatusAutomationEventTypeDto } from '../../../api/types/statusAutomationApi.types';

export const STATUS_AUTOMATION_SECTIONS = [
  { key: 'mdf', label: 'События МДФ' },
  { key: 'payments', label: 'Оплаты' },
  { key: 'messages', label: 'Входящие сигналы' },
  { key: 'order', label: 'Заказы' },
  { key: 'dates', label: 'Даты' },
  { key: 'statuses', label: 'Статусы' },
  { key: 'production', label: 'Производство' },
  { key: 'other', label: 'Другие события' },
] as const;

export type StatusAutomationSection = typeof STATUS_AUTOMATION_SECTIONS[number]['key'];

// MDF has its own section even though the API catalogue calls it production.
// Prefix fallbacks also keep saved rules visible with older/incomplete catalogues.
export function statusAutomationSection(
  eventType: string,
  descriptor?: Pick<StatusAutomationEventTypeDto, 'group'>,
): StatusAutomationSection {
  if (eventType.startsWith('mdf.')) return 'mdf';
  if (descriptor?.group && STATUS_AUTOMATION_SECTIONS.some(({ key }) => key === descriptor.group)) {
    return descriptor.group;
  }
  if (eventType.startsWith('payment.') || eventType === 'order.payment_status_changed') return 'payments';
  if (eventType.startsWith('message.')) return 'messages';
  if (eventType === 'order.planned_completion_date_changed') return 'dates';
  if (eventType === 'order.status_changed' || eventType === 'order.production_status_changed') return 'statuses';
  if (eventType === 'order.created' || eventType === 'order.updated') return 'order';
  return 'other';
}
