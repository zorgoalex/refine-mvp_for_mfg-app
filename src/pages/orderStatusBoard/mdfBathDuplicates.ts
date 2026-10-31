import type { MdfBathDuplicatesOfBath } from '../../api/types/orderStatusBoardApi.types';
import type {
  CncTelegramBathCard,
  CncTelegramTodayColumn,
  CncTelegramBathDuplicate,
  CncTelegramBathDuplicateBlockedReason,
} from '../../api/types/cncTelegramApi.types';

/**
 * «Разобрать дубль» (plan r8): an old bath after a re-cut keeps details that the new bath also has. The board read
 * returns `duplicates` (pairs with other ACTIVE baths) and `reworkMarks` on bath cards; this module turns them into
 * badge and dialog texts. The archive hint is a hint only: archiving is done by the existing «Раскрой» command.
 */

/** Pairs still waiting for a decision (a «rework» mark already decided the pair). */
export function openBathDuplicates(bath: Pick<CncTelegramBathCard, 'duplicates'>): CncTelegramBathDuplicate[] {
  return (bath.duplicates ?? []).filter(entry => entry.resolvedAction === null);
}

/** «Дубль: N дет.»: shared details over all open pairs (union of the visible ones, at least the largest pair). */
export function bathDuplicateBadgeCount(bath: Pick<CncTelegramBathCard, 'duplicates'>): number {
  const open = openBathDuplicates(bath);
  const visible = new Set(open.flatMap(entry => entry.shared.map(s => `${s.orderId}:${s.detailId}`)));
  return Math.max(visible.size, ...open.map(entry => entry.sharedCount), 0);
}

/** «Переделка: N дет.»: distinct marked details (server union over the marked pairs). */
export function bathReworkBadgeCount(bath: Pick<CncTelegramBathCard, 'reworkMarks' | 'reworkDetailCount'>): number {
  if (typeof bath.reworkDetailCount === 'number') return bath.reworkDetailCount;
  return Math.max(0, ...(bath.reworkMarks ?? []).map(mark => mark.detailCount));
}

/** The dialog is offered while any pair exists (open or rework-marked: «Оставить обе» still applies). */
export function bathHasDuplicates(bath: Pick<CncTelegramBathCard, 'duplicates'>): boolean {
  return (bath.duplicates ?? []).length > 0;
}

export const BATH_DUPLICATE_BLOCKED_TEXT: Record<CncTelegramBathDuplicateBlockedReason, string> = {
  scope: 'Нет доступа ко всем заказам другой ванны — подсказка об архивации не показывается.',
  engine: 'Включён новый производственный учёт: покрытие ванн по его составу пока не проверяется, архивацию '
    + 'не подсказываем. Можно оставить обе ванны или пометить общие детали как переделку.',
  not_covered: 'Ванна покрыта не полностью: в ней есть детали, которых в другой ванне нет или меньше.',
  production: 'По ванне уже есть производство (закатка, статус «Закатан» или переделка) — архивировать её нельзя.',
  composition: 'В задании ванны есть позиции, которых нет в другой ванне (ХДФ, неразмещённые или в большем '
    + 'количестве) — архивация удалила бы и их.',
  linked_cards: 'С заданием связаны другие карточки МДФ (файл станка и т. п.) — архивируйте вручную в «Раскрое», '
    + 'подтвердив удаление связанных карточек.',
};

export interface BathArchiveHintView {
  tone: 'success' | 'info' | 'warning';
  text: string;
  /** «Раскрой» page of the job to archive; only for an archivable bath outside the engine. */
  href: string | null;
}

const isOlder = (a: Pick<CncTelegramBathCard, 'cutResultId'>, b: { cutResultId: number }) => a.cutResultId < b.cutResultId;

/** Hint for `bath` (this side of the pair). `older` — whether this bath is the older one of the pair. */
export function bathArchiveHint(bath: Pick<CncTelegramBathCard, 'cutJobId' | 'cutResultId'>,
  entry: CncTelegramBathDuplicate): BathArchiveHintView {
  if (entry.archivable && bath.cutJobId > 0) {
    const other = parseBathCardResultId(entry.otherBathCardId);
    const older = other === null || isOlder(bath, { cutResultId: other });
    return {
      tone: 'success',
      text: older
        ? 'Старая ванна полностью покрыта новой — её можно архивировать в «Раскрое».'
        : 'Эта ванна полностью покрыта другой — её можно архивировать в «Раскрое».',
      href: `/cut?job=${bath.cutJobId}`,
    };
  }
  const reason = entry.blockedReason;
  return {
    tone: reason === 'production' || reason === 'linked_cards' ? 'warning' : 'info',
    text: reason ? BATH_DUPLICATE_BLOCKED_TEXT[reason] : 'Ванна не покрыта другой полностью.',
    href: null,
  };
}

export function parseBathCardResultId(bathCardId: string): number | null {
  const match = /^cut-result:([1-9][0-9]{0,15})$/.exec(bathCardId);
  return match ? Number(match[1]) : null;
}

/** The other side's entry for the same pair, when the other bath is on the board too (its own archive hint). */
export function reverseBathDuplicate(boardBaths: readonly CncTelegramBathCard[], bath: CncTelegramBathCard,
  entry: CncTelegramBathDuplicate): { bath: CncTelegramBathCard; entry: CncTelegramBathDuplicate } | null {
  const other = boardBaths.find(card => card.bathCardId === entry.otherBathCardId);
  const reverse = other?.duplicates?.find(candidate => candidate.otherBathCardId === bath.bathCardId);
  return other && reverse ? { bath: other, entry: reverse } : null;
}

/** Shared details as table rows (order name from this bath's items). */
export function bathDuplicateRows(bath: Pick<CncTelegramBathCard, 'items'>, entry: CncTelegramBathDuplicate) {
  const names = new Map(bath.items.map(item => [item.orderId, item.orderName]));
  return entry.shared.map(s => ({
    key: `${s.orderId}:${s.detailId}`,
    orderName: names.get(s.orderId) ?? String(s.orderId),
    detailNumber: s.detailNumber,
    here: s.here,
    there: s.there,
  }));
}

export function otherBathTitle(entry: CncTelegramBathDuplicate): string {
  return entry.otherJobLabel ?? 'другая ванна (нет доступа ко всем её заказам)';
}

/** A new key per decision attempt; the same key is reused only to retry that exact decision. */
export function newBathDuplicateIdempotencyKey(): string {
  return `bath-dup:${crypto.randomUUID()}`;
}

/** Hybrid board: the engine card keeps the presentation it chose, the duplicates come from the legacy bath card. */
export function withLegacyBathDuplicates<T extends CncTelegramBathCard>(card: T,
  legacy: Pick<CncTelegramBathCard, 'bathCardId' | 'duplicates' | 'reworkMarks' | 'reworkDetailCount'> | undefined): T {
  if (!legacy || legacy.bathCardId !== card.bathCardId) return card;
  if (legacy.duplicates === undefined && legacy.reworkMarks === undefined) return card;
  return { ...card, duplicates: legacy.duplicates, reworkMarks: legacy.reworkMarks,
    reworkDetailCount: legacy.reworkDetailCount };
}

/** Hybrid board: engine bath cards the legacy read did not return get their facts from
 * `GET /orders/status-board/mdf-bath-duplicates`; untouched columns and cards keep their objects. */
export function applyBathDuplicates(columns: CncTelegramTodayColumn[],
  byId: ReadonlyMap<string, MdfBathDuplicatesOfBath>): CncTelegramTodayColumn[] {
  if (!byId.size) return columns;
  return columns.map(column => {
    if (!column.baths.some(bath => byId.has(bath.bathCardId) && bath.duplicates === undefined)) return column;
    return { ...column, baths: column.baths.map(bath => {
      const facts = byId.get(bath.bathCardId);
      return facts && bath.duplicates === undefined
        ? { ...bath, duplicates: facts.duplicates, reworkMarks: facts.reworkMarks, reworkDetailCount: facts.reworkDetailCount }
        : bath;
    }) };
  });
}

/**
 * Engine-only baths' facts are re-read on every board cycle (poll, refresh, decision), not only when the shown ids
 * change: another user's decision changes no id and no engine publication. One refresher lives for the page:
 * - `setContext(ids)` — the engine-only bath set ('' = none / feature off / board hidden). A changed set clears the
 *   shown facts when empty and asks for a read; an answer for a previous set is dropped;
 * - `request()` — a refresh signal. At most one read runs; signals during it coalesce into ONE follow-up read after
 *   it, so a slow read (longer than the poll interval) still applies and reads never overlap;
 * - a failed read keeps the shown facts; the next signal retries.
 * The returned promises settle when the triggered work (incl. a follow-up read) is done — for tests and callers.
 */
export function createEngineBathDuplicatesRefresher(
  fetcher: (bathCardIds: string[]) => Promise<MdfBathDuplicatesOfBath[]>,
  apply: (facts: MdfBathDuplicatesOfBath[]) => void,
): { setContext(bathCardIdsKey: string): Promise<void>; request(): Promise<void> } {
  let context = '';
  let running: Promise<void> | null = null;
  let again = false;
  const run = async (): Promise<void> => {
    do {
      again = false;
      const requested = context;
      if (!requested) return;
      try {
        const facts = await fetcher(requested.split(','));
        if (requested === context) apply(facts);
      } catch {
        // Indicators only: keep what is shown, the next signal retries.
      }
    } while (again);
  };
  const request = (): Promise<void> => {
    if (!context) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => { running = null; });
    return running;
  };
  return {
    setContext(bathCardIdsKey) {
      if (bathCardIdsKey === context) return Promise.resolve();
      context = bathCardIdsKey;
      if (!bathCardIdsKey) {
        apply([]);
        return Promise.resolve();
      }
      return request();
    },
    request,
  };
}
