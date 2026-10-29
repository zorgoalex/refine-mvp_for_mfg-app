import type { ClientMergeHistory, MergeSkipped, MergeView } from '../../api/clientMergesApiTypes';

export const SKIPPED_REASON_LABELS: Record<string, string> = {
  group_changed: 'состав группы изменился',
  group_moved: 'группа передана другому клиенту',
  order_moved: 'заказ перенесён в другую группу',
  client_changed: 'заказ передан другому клиенту',
  changed_after_merge: 'изменено после объединения',
  deleted_after_merge: 'удалено после объединения',
  value_exists: 'такое значение уже есть',
  journal_purged: 'данные журнала стёрты',
  onec_copy: 'копия из 1С (вернётся синхронизацией)',
  onec_key_taken: 'ключ 1С занят другой записью — восстановлено без ключа',
  phone_not_restored: 'телефон не восстановлен',
  link_changed: 'связь с 1С изменилась',
};

export function skippedReasonLabel(reason: string): string {
  return SKIPPED_REASON_LABELS[reason] ?? reason;
}

export function skippedKindLabel(kind: string): string {
  if (kind === 'project') return 'группа';
  if (kind === 'order') return 'заказ';
  if (kind === 'onec_link') return 'связь с 1С';
  if (kind === 'redirect_repointed') return 'ссылка объединения';
  if (kind.startsWith('phone')) return 'телефон';
  if (kind.startsWith('contact')) return 'контакт';
  return kind;
}

export function skippedLine(item: MergeSkipped): string {
  return `${skippedKindLabel(item.kind)} #${item.rowId} — ${skippedReasonLabel(item.reason)}`;
}

export const RETURNED_LABELS: Record<string, string> = {
  projects: 'Групп',
  orders: 'Заказов',
  phones: 'Телефонов',
  contacts: 'Контактов',
  phonesMoved: 'Телефонов возвращено',
  phonesRestored: 'Телефонов восстановлено',
  contactsMoved: 'Контактов возвращено',
  contactsRestored: 'Контактов восстановлено',
  redirectsRestored: 'Ссылок объединения восстановлено',
  onecLink: 'Связь с 1С',
};

export function returnedLines(returned: Record<string, number> | null | undefined): Array<{ key: string; label: string; value: number }> {
  if (!returned) return [];
  return Object.keys(returned)
    .filter((key) => Number(returned[key]) > 0)
    .map((key) => ({ key, label: RETURNED_LABELS[key] ?? key, value: Number(returned[key]) }));
}

export const MERGE_STATUS_LABELS: Record<MergeView['status'], string> = {
  done: 'Выполнено',
  undone: 'Отменено',
};

export interface MergedBanner {
  intoClientId: number;
  intoName: string;
  mergedAt: string | null;
  mergedBy: string | null;
}

/** Data of the «Клиент объединён с …» banner; null when the client is not merged into another. */
export function mergedBanner(history: ClientMergeHistory | null | undefined, clientId: number): MergedBanner | null {
  if (!history?.mergedInto) return null;
  const merge = history.merges.find((item) => item.status === 'done' && item.merged.clientId === clientId);
  return {
    intoClientId: history.mergedInto.clientId,
    intoName: history.mergedInto.name,
    mergedAt: merge?.mergedAt ?? null,
    mergedBy: merge ? (merge.mergedBy.username || `#${merge.mergedBy.userId}`) : null,
  };
}

/** The «Отменить объединение» button is shown only for a merge the backend says can be undone. */
export function undoButtonVisible(merge: Pick<MergeView, 'canUndo' | 'status'>, hasMergePermission: boolean): boolean {
  return hasMergePermission && merge.canUndo && merge.status === 'done';
}

export function canConfirmUndo(
  preview: { obstacles: unknown[]; previewToken: string | null } | null | undefined,
  busy: boolean,
): boolean {
  return Boolean(preview) && !busy && preview!.obstacles.length === 0 && Boolean(preview!.previewToken);
}

export function mergeDirectionText(merge: Pick<MergeView, 'survivor' | 'merged'>): string {
  return `«${merge.merged.name}» → «${merge.survivor.name}»`;
}

/** Text of a client save error: the merged-client DB check is shown in Russian, anything else as is. */
export function saveErrorDescription(raw: string | null | undefined): string {
  if (raw && raw.includes('chk_client_not_merged')) {
    return 'Клиент объединён с другим клиентом: его нельзя снова сделать активным';
  }
  return raw || 'Неизвестная ошибка';
}
