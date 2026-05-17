import type {
  DeadlineDto,
  DeadlineEntityType,
  DeadlineEventDto,
  DeadlineSeverity,
  DeadlineStatus,
  OrderDeadlineSummary,
} from '../../../api/types/deadlineApi.types';

export interface DeadlineRow {
  key: string;
  entity: string;
  deadlineAt: string;
  status: string;
  statusCode: DeadlineStatus;
  source: string;
  severityColor: string;
  updatedAt: string;
}

export interface DeadlineEventRow {
  key: string;
  eventType: string;
  severity: DeadlineSeverity;
  severityColor: string;
  eventAt: string;
  delay: string;
}

const STATUS_LABELS: Record<DeadlineStatus, string> = {
  active: 'Активен',
  paused: 'На паузе',
  expired: 'Просрочен',
  completed_on_time: 'Завершен в срок',
  completed_late: 'Завершен поздно',
  cancelled: 'Отменен',
  superseded: 'Заменен',
};

const ENTITY_LABELS: Record<DeadlineEntityType, string> = {
  order: 'Заказ',
  order_stage: 'Этап',
  client_action: 'Действие клиента',
  project: 'Проект',
  task: 'Задача',
};

export function buildDeadlineRows(deadlines: DeadlineDto[]): DeadlineRow[] {
  return deadlines.map((deadline) => ({
    key: deadline.deadlineId,
    entity: ENTITY_LABELS[deadline.entityType] ?? deadline.entityType,
    deadlineAt: formatDeadlineDate(deadline.deadlineAt),
    status: getDeadlineStatusLabel(deadline.status),
    statusCode: deadline.status,
    source: deadline.source,
    severityColor: getStatusSeverityColor(deadline.status),
    updatedAt: formatDeadlineDate(deadline.updatedAt),
  }));
}

export function buildDeadlineEventRows(events: DeadlineEventDto[]): DeadlineEventRow[] {
  return events.map((event) => ({
    key: event.deadlineEventId,
    eventType: event.eventType,
    severity: event.severity,
    severityColor: getDeadlineSeverityColor(event.severity),
    eventAt: formatDeadlineDate(event.eventAt),
    delay: formatDeadlineDuration(event.delayMinutes ?? null),
  }));
}

export function summarizeDeadlineCounts(summary: OrderDeadlineSummary | null): string {
  if (!summary) return 'Нет данных по дедлайнам';

  return [
    `Активные: ${summary.counts.active}`,
    `Просрочены: ${summary.counts.expired}`,
    `Поздно завершены: ${summary.counts.completedLate}`,
    `В срок: ${summary.counts.completedOnTime}`,
  ].join(' · ');
}

export function getDeadlineStatusLabel(status: DeadlineStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function getDeadlineSeverityColor(severity: DeadlineSeverity): string {
  if (severity === 'critical') return 'red';
  if (severity === 'warning') return 'orange';
  return 'blue';
}

export function formatDeadlineDate(value: string | null | undefined): string {
  if (!value) return '—';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatDeadlineDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';

  const absoluteMinutes = Math.abs(Math.trunc(minutes));
  const hours = Math.floor(absoluteMinutes / 60);
  const remainingMinutes = absoluteMinutes % 60;

  if (hours === 0) return `${remainingMinutes} мин`;
  if (remainingMinutes === 0) return `${hours} ч`;
  return `${hours} ч ${remainingMinutes} мин`;
}

function getStatusSeverityColor(status: DeadlineStatus | string): string {
  if (status === 'expired' || status === 'completed_late') return 'red';
  if (status === 'active' || status === 'paused') return 'orange';
  if (
    status === 'completed_on_time' ||
    status === 'cancelled' ||
    status === 'superseded'
  ) {
    return 'green';
  }
  return 'blue';
}
