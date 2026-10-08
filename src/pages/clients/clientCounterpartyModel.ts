import { ApiError } from '../../api/apiError';
import type {
  ClientConfirmResult, ClientConfirmStatus, ClientCounterparty, ClientCounterpartyMatch, ClientCounterpartyReason, ClientMatchStrength, CounterpartyCard,
} from '../../api/partyContactsApi';

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

/** Choosing a counterparty shows phones and BIN/IIN of the whole 1C directory: both rights are needed. */
export function canChooseCounterparty(can: (permission: 'clients.update' | 'clients.onec_data.view') => boolean): boolean {
  return can('clients.update') && can('clients.onec_data.view');
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

// ── Bulk confirmation ────────────────────────────────────────────────────────

export const STRENGTH_LABELS: Record<ClientMatchStrength, string> = {
  both: 'имя и телефон',
  phone: 'только телефон',
  name: 'только имя',
};

export const STRENGTH_COLORS: Record<ClientMatchStrength, string> = { both: 'green', phone: 'blue', name: 'gold' };

/** Selected from the start: only the pairs where both the name and a phone are equal. */
export function defaultSelection(matches: readonly ClientCounterpartyMatch[]): number[] {
  return matches.filter((match) => match.strength === 'both').map((match) => match.clientId);
}

export function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

const REFUSALS: Record<Exclude<ClientConfirmStatus, 'linked' | 'uncertain'>, string> = {
  conflict: 'у клиента уже появилось другое сопоставление',
  taken: 'контрагент уже сопоставлен с другим клиентом',
  unknown: 'контрагента больше нет в загруженных данных 1С',
  not_found: 'клиент не найден',
};

export interface ConfirmPair { clientId: number; refKey1c: string }

export interface ConfirmRun {
  /** Answers the server gave. */
  results: ClientConfirmResult[];
  /** Pairs of the part whose answer never came: they may or may not be linked. */
  unanswered: ConfirmPair[];
  /** Pairs never sent: the run stopped at the part that got no answer. */
  notSent: ConfirmPair[];
  /** Text of the failure that stopped the run. */
  failure: string | null;
}

/**
 * Sends the pairs part by part, each part ONCE. A pair is the link command with «no counterparty» as the expected
 * state, so sending a part again after a lost answer would link once more a client whose link somebody removed in
 * the meantime. A part without an answer stops the run: its pairs are checked by reading (see `verifyPairs`), the
 * later parts are not sent.
 */
export async function runConfirmation(
  pairs: readonly ConfirmPair[], send: (part: ConfirmPair[]) => Promise<{ results: ClientConfirmResult[] }>,
  size: number, onProgress: (answered: number) => void = () => undefined,
): Promise<ConfirmRun> {
  const results: ClientConfirmResult[] = [];
  const parts = chunks(pairs, size);
  for (let index = 0; index < parts.length; index += 1) {
    try {
      results.push(...(await send(parts[index])).results);
    } catch (error) {
      return {
        results, unanswered: parts[index], notSent: parts.slice(index + 1).flat(),
        failure: error instanceof Error ? error.message : 'Запрос не выполнен',
      };
    }
    onProgress(results.length);
  }
  return { results, unanswered: [], notSent: [], failure: null };
}

/** Pairs whose outcome the answers do not tell: no answer at all, or the server reported an uncertain pair. */
export function pairsToVerify(run: Pick<ConfirmRun, 'results' | 'unanswered'>): ConfirmPair[] {
  return [
    ...run.results.filter((result) => result.status === 'uncertain').map((result) => ({ clientId: result.clientId, refKey1c: result.refKey1c })),
    ...run.unanswered,
  ];
}

export interface Verification {
  /** The client is linked to exactly this counterparty now. */
  linked: ConfirmPair[];
  /** The client was not linked to it when read (no link, or another one) — not a proof that it never will be. */
  notLinked: ConfirmPair[];
  /** The link could not be read either. */
  unknown: ConfirmPair[];
}

/** Reads the current link of every client of the pairs (a few at a time) and compares the exact key. Writes nothing. */
export async function verifyPairs(
  pairs: readonly ConfirmPair[], readKey: (clientId: number) => Promise<string | null>, concurrency = 4,
): Promise<Verification> {
  const verification: Verification = { linked: [], notLinked: [], unknown: [] };
  const queue = [...pairs];
  const worker = async () => {
    for (let pair = queue.shift(); pair; pair = queue.shift()) {
      try {
        const key = await readKey(pair.clientId);
        (key !== null && key.toLowerCase() === pair.refKey1c.toLowerCase() ? verification.linked : verification.notLinked).push(pair);
      } catch {
        verification.unknown.push(pair);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, pairs.length)) }, worker));
  const order = new Map(pairs.map((pair, index) => [pair.clientId, index] as const));
  for (const list of [verification.linked, verification.notLinked, verification.unknown]) list.sort((a, b) => (order.get(a.clientId) ?? 0) - (order.get(b.clientId) ?? 0));
  return verification;
}

/** A pair whose outcome nobody can tell yet; the client is named so that its card can be opened. */
export interface UnknownPair {
  clientId: number;
  clientName: string;
  /**
   * `pending` — no certain answer and the link was not there when it was read: the write may still be in flight
   * (the request still running, or a commit still being finished by the database) and link the client later.
   * `unreadable` — neither a certain answer nor a successful read.
   */
  state: 'pending' | 'unreadable';
}

export interface ConfirmSummary {
  linked: number;
  /** One line per pair that is certainly not in place: «Иванов — контрагент уже сопоставлен с другим клиентом («Петров»)». */
  refused: string[];
  /** The result is unknown; never counted as linked or as skipped. */
  unknown: UnknownPair[];
  notSent: number;
}

/**
 * Only a read that FINDS the link is a proof: the pair is in place. A read that does not find it proves nothing —
 * neither for a part whose answer was lost (the server may still be working through it) nor for a pair the server
 * reported as uncertain (its commit may still be finished by the database after the answer). Such pairs stay
 * unknown and are named; «skipped» is said only on a certain refusal of the server.
 */
export function confirmSummary(
  run: Pick<ConfirmRun, 'results' | 'notSent'>, verification: Verification, names: ReadonlyMap<number, string>,
): ConfirmSummary {
  const name = (clientId: number) => names.get(clientId) ?? `#${clientId}`;
  const refused = run.results.filter((result) => result.status !== 'linked' && result.status !== 'uncertain').map((result) => {
    const reason = REFUSALS[result.status as keyof typeof REFUSALS] ?? 'не удалось сопоставить';
    const holder = result.status === 'taken' && result.holderClientName ? ` («${result.holderClientName}»)` : '';
    return `${name(result.clientId)} — ${reason}${holder}`;
  });
  const unknown: UnknownPair[] = [
    ...verification.notLinked.map((pair) => ({ clientId: pair.clientId, clientName: name(pair.clientId), state: 'pending' as const })),
    ...verification.unknown.map((pair) => ({ clientId: pair.clientId, clientName: name(pair.clientId), state: 'unreadable' as const })),
  ];
  return {
    linked: run.results.filter((result) => result.status === 'linked').length + verification.linked.length, refused, unknown, notSent: run.notSent.length,
  };
}

/** The outcome in one line; unknown results are never counted as linked or as skipped. */
export function confirmHeadline(summary: ConfirmSummary): string {
  return [
    `Сопоставлено: ${summary.linked}`,
    summary.refused.length > 0 ? `пропущено: ${summary.refused.length}` : null,
    summary.unknown.length > 0 ? `результат неизвестен: ${summary.unknown.length}` : null,
    summary.notSent > 0 ? `не отправлено: ${summary.notSent}` : null,
  ].filter(Boolean).join(', ');
}

export const UNKNOWN_STATE_LABELS: Record<UnknownPair['state'], string> = {
  pending: 'на момент проверки не сопоставлен — запись могла ещё выполняться',
  unreadable: 'состояние прочитать не удалось',
};

/** «12 клиентов» / «1 клиент» / «3 клиента». */
export function clientsCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const word = mod10 === 1 && mod100 !== 11 ? 'клиент' : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? 'клиента' : 'клиентов';
  return `${count} ${word}`;
}
