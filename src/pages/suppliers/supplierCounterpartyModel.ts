import { ApiError } from '../../api/apiError';
import type { SupplierCounterparty, SupplierOnecProfile, SupplierOnecSyncOutcome } from '../../api/partyContactsApi';

export interface CounterpartyOption { value: string; label: string; disabled: boolean }

/** Options of the «Контрагент 1С» select: a counterparty of another supplier is shown but cannot be chosen. */
export function counterpartyOptions(items: readonly SupplierCounterparty[], supplierId: number): CounterpartyOption[] {
  return items.map((item) => {
    const other = item.supplierId !== null && item.supplierId !== supplierId;
    return {
      value: item.refKey1c,
      label: `${item.name}${item.isSupplier ? ' · поставщик в 1С' : ''}${other ? ` — уже привязан к «${item.supplierName ?? `#${item.supplierId}`}»` : ''}`,
      disabled: other,
    };
  });
}

const LINK_ERRORS: Record<string, string> = {
  SUPPLIER_COUNTERPARTY_TAKEN: 'Этот контрагент 1С уже привязан к другому поставщику.',
  SUPPLIER_COUNTERPARTY_UNKNOWN: 'Такого контрагента нет в загруженных данных 1С.',
  SUPPLIER_NOT_FOUND: 'Поставщик не найден — обновите страницу.',
  PERMISSION_DENIED: 'Недостаточно прав для изменения привязки.',
};

export const SUPPLIER_COUNTERPARTY_CONFLICT = 'SUPPLIER_COUNTERPARTY_CONFLICT';

export function supplierLinkErrorMessage(error: unknown): string {
  if (error instanceof ApiError && LINK_ERRORS[error.code]) return LINK_ERRORS[error.code];
  return 'Не удалось изменить привязку к контрагенту 1С.';
}

/** A backend without the link API (older release): the block is hidden. */
export function isCounterpartyApiMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code !== 'SUPPLIER_NOT_FOUND';
}

const CONTACTS_STATE: Record<SupplierOnecProfile['contactsState'], string | null> = {
  available: null,
  not_loaded: 'Контакты контрагентов из 1С ещё не загружались',
  revoked: 'Контакты из 1С отозваны: их копия удалена',
  expired: 'Контакты из 1С устарели (больше 30 дней без обновления): их копия удалена',
  unavailable: 'Контакты из 1С сейчас недоступны и скрыты; при ближайшей сверке они будут удалены',
};
const COUNTERPARTY_STATE: Record<SupplierOnecProfile['counterpartyState'], string | null> = {
  active: null,
  deletion_mark: 'Контрагент помечен в 1С на удаление',
  missing: 'Контрагента нет в последней выгрузке 1С',
  not_found: 'Контрагент не найден в загруженных данных 1С',
};

/** What the card says about the 1C side of a supplier: ИИН/БИН, the last sync, and warnings. */
export function onecProfileView(profile: SupplierOnecProfile | null | undefined, now = new Date()): {
  identificationNumber: string | null; syncedText: string | null; warnings: string[];
} {
  if (!profile) return { identificationNumber: null, syncedText: null, warnings: [] };
  const warnings = [COUNTERPARTY_STATE[profile.counterpartyState], CONTACTS_STATE[profile.contactsState]].filter((text): text is string => text !== null);
  if (profile.skipped > 0) warnings.push(`Не распознано значений из 1С: ${profile.skipped}`);
  const synced = new Date(profile.syncedAt);
  const sameDay = synced.toDateString() === now.toDateString();
  const time = synced.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return {
    identificationNumber: profile.identificationNumber,
    syncedText: `Сверено с 1С ${sameDay ? `сегодня в ${time}` : `${synced.toLocaleDateString('ru-RU')} в ${time}`}`,
    warnings,
  };
}

/** The message after «Сверить с 1С». */
export function onecSyncMessage(outcome: SupplierOnecSyncOutcome): { type: 'success' | 'info' | 'warning'; text: string } {
  if (outcome.status === 'skipped') {
    const reasons: Record<typeof outcome.reason, string> = {
      not_found: 'Поставщик не найден — обновите страницу',
      no_source: 'Контрагент не найден ни в одной базе 1С',
      not_loaded: 'Контакты контрагентов из 1С ещё не загружались — сверять пока не с чем',
      mirror_unavailable: 'Данные 1С сейчас недоступны',
    };
    return { type: 'warning', text: reasons[outcome.reason] };
  }
  if (outcome.status === 'unchanged') return { type: 'info', text: 'Контакты совпадают с 1С' };
  const parts = [outcome.added && `добавлено ${outcome.added}`, outcome.updated && `изменено ${outcome.updated}`, outcome.removed && `удалено ${outcome.removed}`]
    .filter(Boolean);
  return { type: 'success', text: `Контакты из 1С обновлены: ${parts.join(', ')}` };
}
