import { ApiError } from '../../api/apiError';
import type { ClientCounterparty, ClientCounterpartyReason, CounterpartyCard } from '../../api/partyContactsApi';

const REASONS: Record<ClientCounterpartyReason, string> = {
  name: 'совпадает имя',
  phone: 'совпадает телефон',
  similar: 'похожее имя',
};

/** «совпадает имя, совпадает телефон» — exact reasons first; a similar name is not repeated next to an equal one. */
export function matchReasons(matchedBy: readonly ClientCounterpartyReason[]): string {
  const order: ClientCounterpartyReason[] = ['name', 'phone', 'similar'];
  return order.filter((reason) => matchedBy.includes(reason) && !(reason === 'similar' && matchedBy.includes('name')))
    .map((reason) => REASONS[reason]).join(', ');
}

/** «Код НФ-001560 · БИН 123456789012 · 8 701 555 01 01» — what tells two counterparties of one name apart. */
export function counterpartyDetails(card: Pick<CounterpartyCard, 'code' | 'bin' | 'phones'>): string {
  return [
    card.code ? `код ${card.code}` : null,
    card.bin ? `БИН/ИИН ${card.bin}` : null,
    card.phones.length > 0 ? card.phones.slice(0, 3).join(', ') + (card.phones.length > 3 ? ` и ещё ${card.phones.length - 3}` : '') : null,
  ].filter(Boolean).join(' · ');
}

/** A counterparty of another client is shown but cannot be chosen. */
export function takenBy(item: Pick<ClientCounterparty, 'clientId' | 'clientName'>, clientId: number): string | null {
  if (item.clientId === null || item.clientId === clientId) return null;
  return item.clientName ?? `#${item.clientId}`;
}

export interface CounterpartyOption { value: string; label: string; disabled: boolean }

export function counterpartyOptions(items: readonly ClientCounterparty[], clientId: number): CounterpartyOption[] {
  return items.map((item) => {
    const other = takenBy(item, clientId);
    const details = counterpartyDetails(item);
    return {
      value: item.refKey1c,
      label: `${item.name}${details ? ` · ${details}` : ''}${other ? ` — уже сопоставлен с клиентом «${other}»` : ''}`,
      disabled: other !== null,
    };
  });
}

const LINK_ERRORS: Record<string, string> = {
  CLIENT_COUNTERPARTY_UNKNOWN: 'Такого контрагента нет в загруженных данных 1С.',
  CLIENT_NOT_FOUND: 'Клиент не найден — обновите страницу.',
  PERMISSION_DENIED: 'Недостаточно прав для изменения сопоставления.',
};

export const CLIENT_COUNTERPARTY_CONFLICT = 'CLIENT_COUNTERPARTY_CONFLICT';

export function clientLinkErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === 'CLIENT_COUNTERPARTY_TAKEN') {
    const holder = (error.details as { clientName?: unknown } | undefined)?.clientName;
    return typeof holder === 'string' && holder
      ? `Этот контрагент 1С уже сопоставлен с клиентом «${holder}». Сначала снимите сопоставление у него.`
      : 'Этот контрагент 1С уже сопоставлен с другим клиентом.';
  }
  if (error instanceof ApiError && LINK_ERRORS[error.code]) return LINK_ERRORS[error.code];
  return 'Не удалось изменить сопоставление с контрагентом 1С.';
}

/** A backend without the link API (older release): the block is hidden. */
export function isCounterpartyApiMissing(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code !== 'CLIENT_NOT_FOUND';
}
