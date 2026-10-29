import type {
  DuplicateCaseView,
  DuplicateDetectedVia,
  DuplicateEntityKind,
  DuplicateMember,
  DuplicateStatus,
  DuplicateSystem,
  DuplicateUserRef,
} from '../../api/integrationDuplicatesApiTypes';

export const DUPLICATE_STATUS_LABELS: Record<DuplicateStatus, string> = {
  open: 'Открыт',
  dismissed: 'Не дубль',
  external: 'Исправить в 1С',
  merged: 'Объединён',
  resolved: 'Закрыт',
};

export const DUPLICATE_STATUS_COLORS: Record<DuplicateStatus, string> = {
  open: 'orange',
  dismissed: 'default',
  external: 'blue',
  merged: 'green',
  resolved: 'green',
};

export const DUPLICATE_STATUS_ORDER: DuplicateStatus[] = ['open', 'dismissed', 'external', 'merged', 'resolved'];

export const DUPLICATE_VIA_LABELS: Record<DuplicateDetectedVia, string> = {
  erp_manual: 'Вручную в ERP',
  bitrix_inbound: 'Из Bitrix24',
  onec_publication: 'Из 1С',
  catalog_import: 'Импорт каталога',
  order_import: 'Импорт заказа',
  scan: 'Проверка журнала',
};

export const DUPLICATE_SYSTEM_LABELS: Record<DuplicateSystem, string> = {
  erp: 'ERP',
  bitrix: 'Bitrix24',
  onec: '1С',
};

export const DUPLICATE_SYSTEM_COLORS: Record<DuplicateSystem, string> = {
  erp: 'geekblue',
  bitrix: 'cyan',
  onec: 'gold',
};

export const DUPLICATE_STRENGTH_LABELS = { exact: 'Точное', likely: 'Вероятное' } as const;

export const DUPLICATE_ACTION_LABELS: Record<string, string> = {
  detected: 'Обнаружен',
  member_joined: 'Запись добавилась',
  member_left: 'Запись ушла',
  dismissed: 'Отмечен «Не дубль»',
  marked_external: 'Отмечен «Исправить в 1С»',
  reopened: 'Открыт снова',
  resolved: 'Закрыт',
  source_refreshed: 'Данные 1С обновлены',
};

export const DUPLICATE_RESOLUTION_LABELS: Record<string, string> = {
  no_match: 'совпадение пропало',
  source_revoked: 'данные 1С отозваны',
  source_expired: 'истёк срок хранения данных 1С',
  not_duplicate: 'не дубль',
  fix_in_onec: 'исправить в 1С',
  different_records: 'разные записи',
  related_records: 'связанные записи (так и должно быть)',
  test_data: 'тестовые данные',
  other: 'другая причина',
  user: 'вручную',
  new_member: 'добавилась новая запись',
  matched_again: 'совпадение появилось снова',
};

/** Why a case is «Не дубль»: fixed reasons only — a free text could carry a phone or an IIN past the masks. */
export const DUPLICATE_REASONS = ['different_records', 'related_records', 'test_data', 'other'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

export function statusLabel(status: string): string {
  return DUPLICATE_STATUS_LABELS[status as DuplicateStatus] ?? status;
}

export function viaLabel(via: string | null | undefined): string {
  return DUPLICATE_VIA_LABELS[via as DuplicateDetectedVia] ?? '—';
}

export function systemLabel(system: string): string {
  return DUPLICATE_SYSTEM_LABELS[system as DuplicateSystem] ?? system;
}

export function actionLabel(action: string): string {
  return DUPLICATE_ACTION_LABELS[action] ?? action;
}

export function resolutionLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return DUPLICATE_RESOLUTION_LABELS[code] ?? code;
}

/** Key shown in the list: the mask, or a note when 1C data is not available right now. */
export function keyMaskText(item: Pick<DuplicateCaseView, 'keyMask' | 'sourcesState'>): string {
  if (item.keyMask) return item.keyMask;
  if (item.sourcesState === 'unavailable') return 'данные 1С отозваны';
  if (item.sourcesState === 'refreshing') return 'данные 1С обновляются';
  return '—';
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Almaty',
  });
}

export function userText(user: DuplicateUserRef | null | undefined): string {
  if (!user) return '—';
  return user.username || `#${user.userId}`;
}

export function activeMembers<T extends DuplicateMember>(members: readonly T[]): T[] {
  return members.filter((member) => !member.leftAt);
}

const KIND_FALLBACK: Partial<Record<DuplicateEntityKind, string>> = {
  client: 'Клиент',
  supplier: 'Поставщик',
  vendor: 'Производитель',
  film: 'Плёнка',
  sheet_material: 'Листовой материал',
  material: 'Материал',
  onec_counterparty: 'Контрагент 1С',
  onec_item: 'Номенклатура 1С',
};

/** Member name; without the right to see it, a short fallback (never an empty cell). */
export function memberName(member: Pick<DuplicateMember, 'name' | 'entityKind' | 'erpEntityId' | 'recordKey'>): string {
  if (member.name) return member.name;
  const kind = KIND_FALLBACK[member.entityKind] ?? 'Запись';
  return member.erpEntityId != null ? `${kind} #${member.erpEntityId}` : 'нет доступа';
}

/** Author of the most recently joined (still present) member: username, external author, or a dash. */
export function caseAuthor(members: readonly DuplicateMember[]): string {
  const present = activeMembers(members);
  const pool = present.length ? present : members;
  if (!pool.length) return '—';
  const latest = [...pool].sort((a, b) => Date.parse(b.joinedAt) - Date.parse(a.joinedAt))[0];
  if (latest.author) return userText(latest.author);
  return latest.authorExternal || '—';
}

/** Route of the ERP card of a member, when there is one. */
export function memberErpLink(member: Pick<DuplicateMember, 'system' | 'entityKind' | 'erpEntityId'>): string | null {
  if (member.system !== 'erp' || member.erpEntityId == null) return null;
  if (member.entityKind === 'client') return `/clients/edit/${member.erpEntityId}`;
  if (member.entityKind === 'supplier') return `/suppliers/edit/${member.erpEntityId}`;
  if (member.entityKind === 'vendor') return `/vendors/edit/${member.erpEntityId}`;
  return null;
}

export interface DuplicateActionAvailability {
  dismiss: boolean;
  external: boolean;
  reopen: boolean;
}

export function availableActions(
  card: { status: DuplicateStatus; external: 'onec' | null },
  canResolve: boolean,
): DuplicateActionAvailability {
  if (!canResolve) return { dismiss: false, external: false, reopen: false };
  return {
    dismiss: card.status === 'open',
    external: card.status === 'open' && card.external === 'onec',
    reopen: card.status === 'dismissed' || card.status === 'external',
  };
}

/** A command may be sent only for the card that is shown and loaded (never for the previous case of the drawer). */
export function commandAllowed(card: { caseId: number } | null, shownCaseId: number | null, loading: boolean): boolean {
  return card !== null && !loading && card.caseId === shownCaseId;
}
