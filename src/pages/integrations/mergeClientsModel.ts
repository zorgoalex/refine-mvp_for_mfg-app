import type { DuplicateCaseDetail, DuplicateMemberDetail } from '../../api/integrationDuplicatesApiTypes';
import type { MergePreview, MergeWarningCode } from '../../api/clientMergesApiTypes';

export const MERGE_WARNING_LABELS: Record<MergeWarningCode, string> = {
  PERSON_TYPE_DIFFERS: 'Разный тип лица — останется тип остающегося клиента',
  MERGED_NOTES_STAY: 'Заметки объединяемого клиента не переносятся (останутся в его архивной карточке)',
  BITRIX_CONTACT_STAYS:
    'Контакт объединяемого клиента в Bitrix24 останется и получит пометку; сделки перейдут на контакт остающегося',
  PHONE_ONEC_KEY_LOST: 'У совпавшего телефона ключ 1С объединяемого клиента не сохранится',
};

export function warningLabel(code: string): string {
  return (MERGE_WARNING_LABELS as Record<string, string>)[code] ?? code;
}

export const MERGE_COUNT_LABELS: Record<string, string> = {
  projects: 'Групп',
  orders: 'Заказов',
  phonesMoved: 'Телефонов перенесено',
  phonesDeleted: 'Телефонов-дублей удалено',
  phoneKeysMoved: 'Ключей 1С телефонов перенесено',
  phoneKeysLost: 'Ключей 1С телефонов потеряно',
  contactsMoved: 'Контактов перенесено',
  contactsDeleted: 'Контактов-дублей удалено',
  onecLink: 'Связь с 1С',
  redirectsRepointed: 'Ссылок объединения переставлено',
};

/** Non-zero counts of a merge with Russian labels, in the order of MERGE_COUNT_LABELS. */
export function countLines(counts: Record<string, number> | null | undefined): Array<{ key: string; label: string; value: number }> {
  if (!counts) return [];
  const known = Object.keys(MERGE_COUNT_LABELS)
    .filter((key) => Number(counts[key]) > 0)
    .map((key) => ({ key, label: MERGE_COUNT_LABELS[key], value: Number(counts[key]) }));
  const unknown = Object.keys(counts)
    .filter((key) => !(key in MERGE_COUNT_LABELS) && Number(counts[key]) > 0)
    .map((key) => ({ key, label: key, value: Number(counts[key]) }));
  return [...known, ...unknown];
}

export interface MergeableMember {
  clientId: number;
  name: string;
  createdAt: string | null;
  orderCount: number | null;
}

/** Order count of a member when its facts show it (a fact whose label mentions orders with a numeric value). */
export function memberOrderCount(member: Pick<DuplicateMemberDetail, 'facts'>): number | null {
  for (const fact of member.facts ?? []) {
    if (fact.hidden || fact.label !== 'Заказов') continue;
    const value = typeof fact.value === 'number' ? fact.value : Number(String(fact.value ?? '').trim());
    if (Number.isFinite(value) && String(fact.value ?? '').trim() !== '') return value;
  }
  return null;
}

/** Active ERP client members of an open client case — the ones that can be merged. */
export function mergeableMembers(
  card: Pick<DuplicateCaseDetail, 'entityKind' | 'status' | 'members'> | null | undefined,
): MergeableMember[] {
  if (!card || card.entityKind !== 'client' || card.status !== 'open') return [];
  const seen = new Set<number>();
  const result: MergeableMember[] = [];
  for (const member of card.members) {
    if (member.system !== 'erp' || member.entityKind !== 'client' || member.leftAt) continue;
    if (member.erpEntityId == null || seen.has(member.erpEntityId)) continue;
    seen.add(member.erpEntityId);
    result.push({
      clientId: member.erpEntityId,
      name: member.name || `Клиент #${member.erpEntityId}`,
      createdAt: member.recordCreatedAt,
      orderCount: memberOrderCount(member),
    });
  }
  return result;
}

export function canMergeCase(
  card: Pick<DuplicateCaseDetail, 'entityKind' | 'status' | 'members'> | null | undefined,
  hasMergePermission: boolean,
): boolean {
  return hasMergePermission && mergeableMembers(card).length >= 2;
}

function time(value: string | null): number {
  const t = value ? Date.parse(value) : NaN;
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/** The client that stays by default: more orders when known, otherwise the earliest created (then the lowest id). */
export function defaultSurvivorId(members: readonly MergeableMember[]): number | null {
  if (!members.length) return null;
  const sorted = [...members].sort((a, b) => {
    const ao = a.orderCount ?? -1;
    const bo = b.orderCount ?? -1;
    if (ao !== bo) return bo - ao;
    const at = time(a.createdAt);
    const bt = time(b.createdAt);
    if (at !== bt) return at - bt;
    return a.clientId - b.clientId;
  });
  return sorted[0].clientId;
}

/** After the survivor changes: keep the merged one if still valid, otherwise the first other member. */
export function resolveMergedId(
  members: readonly MergeableMember[],
  survivorId: number | null,
  currentMergedId: number | null,
): number | null {
  const others = members.filter((member) => member.clientId !== survivorId);
  if (currentMergedId != null && others.some((member) => member.clientId === currentMergedId)) return currentMergedId;
  return others.length ? others[0].clientId : null;
}

export function canConfirmMerge(preview: Pick<MergePreview, 'obstacles'> | null | undefined, busy: boolean): boolean {
  return Boolean(preview) && !busy && (preview?.obstacles.length ?? 1) === 0;
}

export function confirmText(survivorName: string, mergedName: string): string {
  return `Заказы, телефоны и контакты перейдут к «${survivorName}»; клиент «${mergedName}» станет архивным. `
    + 'Отменить можно в течение 30 дней в карточке клиента.';
}

export type MergeErrorAction = 'refresh_preview' | 'reload_case' | 'none';

export interface MergeErrorInfo { message: string; action: MergeErrorAction }

/** Russian message and follow-up for an ApiError code of the merge/undo commands. */
export function mergeErrorInfo(code: string | undefined, fallback?: string): MergeErrorInfo {
  switch (code) {
    case 'CLIENT_MERGE_DISABLED':
      return { message: 'Объединение клиентов пока выключено', action: 'none' };
    case 'CLIENT_MERGE_PREVIEW_STALE':
    case 'CLIENT_MERGE_UNDO_STALE':
      return { message: 'Данные изменились — проверьте ещё раз', action: 'refresh_preview' };
    case 'DUPLICATE_CASE_CHANGED':
      return { message: 'Дело изменилось, пока вы его смотрели. Данные обновлены — проверьте ещё раз', action: 'reload_case' };
    case 'CLIENT_MERGE_BUSY':
      return { message: 'Клиентов сейчас изменяют; повторите через минуту', action: 'none' };
    case 'CLIENT_MERGE_BLOCKED':
    case 'CLIENT_MERGE_UNDO_BLOCKED':
      return { message: 'Есть препятствия — объединение сейчас невозможно', action: 'refresh_preview' };
    case 'CLIENT_MERGE_ALREADY_UNDONE':
      return { message: 'Это объединение уже отменено', action: 'reload_case' };
    case 'CLIENT_MERGE_UNDO_EXPIRED':
      return { message: 'Срок отмены истёк', action: 'reload_case' };
    case 'IDEMPOTENCY_KEY_REUSED':
      return { message: 'Эта операция уже выполнялась с другими данными. Закройте окно и откройте заново', action: 'none' };
    case 'DUPLICATE_CASE_NOT_FOUND':
      return { message: 'Дело не найдено', action: 'none' };
    case 'CLIENT_NOT_FOUND':
      return { message: 'Клиент не найден', action: 'none' };
    case 'CLIENT_MERGED':
      return { message: 'Клиент уже объединён с другим клиентом', action: 'reload_case' };
    default:
      return { message: fallback || 'Не удалось выполнить действие', action: 'none' };
  }
}

/** Obstacles carried by a 409 *_BLOCKED error (details.obstacles), if any. */
export function obstaclesFromDetails(details: unknown): Array<{ code: string; message: string }> {
  const list = (details as { obstacles?: unknown } | null | undefined)?.obstacles;
  if (!Array.isArray(list)) return [];
  return list
    .filter((item): item is { code: string; message: string } =>
      Boolean(item) && typeof (item as { message?: unknown }).message === 'string')
    .map((item) => ({ code: String(item.code ?? ''), message: item.message }));
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

/** A contact of the merge preview as a line: a copy from 1C has no value and returns by the 1C link. */
export function droppedContactLine(contact: { kind: string; value: string | null; origin?: 'erp' | 'onec' }):
  { text: string; note: string; strike: boolean } {
  if (contact.origin === 'onec' || contact.value == null) {
    return { text: 'контакт из 1С', note: '— удалится, вернётся по связи с 1С', strike: false };
  }
  return { text: `${contact.kind}: ${contact.value}`, note: '— уже есть', strike: true };
}
