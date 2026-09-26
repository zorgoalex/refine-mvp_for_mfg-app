import { isApiError } from '../api/apiError';

/**
 * Backend rejects order commands with 409 when the change touches production
 * already accounted on the MDF board. See ApiError.details.cards for the
 * per-card breakdown of what is blocking the change.
 */
export const MDF_ORDER_CONFLICT_CODES = [
  'MDF_ORDER_SOURCE_PENDING',
  'MDF_ORDER_SOURCE_ATTENTION',
  'MDF_ORDER_PHYSICAL_CONFLICT',
  'MDF_ORDER_ASSIGNMENT_CONFLICT',
  'MDF_ORDER_DEMAND_EMPTY',
  'MDF_ORDER_LOCK_CONTENTION',
  'MDF_ORDER_SCOPE_LIMIT',
  'MDF_ENGINE_READ_ONLY',
  'MDF_ORDER_CONFIRMATION_STALE',
] as const;

export type MdfOrderConflictCode = (typeof MDF_ORDER_CONFLICT_CODES)[number];

const MDF_ORDER_CONFLICT_CODE_SET: ReadonlySet<string> = new Set(MDF_ORDER_CONFLICT_CODES);

// Retry is the whole remedy for these two: the card is mid-write or another
// request holds its lock, nothing about the user's change is actually wrong.
const MDF_ORDER_CONFLICT_RETRY_CODES: ReadonlySet<string> = new Set([
  'MDF_ORDER_SOURCE_PENDING',
  'MDF_ORDER_LOCK_CONTENTION',
]);

const MDF_ORDER_CONFLICT_TITLES: Record<MdfOrderConflictCode, string> = {
  MDF_ORDER_SOURCE_PENDING: 'Карточка МДФ ещё обрабатывается',
  MDF_ORDER_SOURCE_ATTENTION: 'Карточка МДФ требует проверки',
  MDF_ORDER_PHYSICAL_CONFLICT: 'Позиции уже раскроены или зарезервированы',
  MDF_ORDER_ASSIGNMENT_CONFLICT: 'Позиции закреплены в карточках МДФ',
  MDF_ORDER_DEMAND_EMPTY: 'Нет потребности для карточки МДФ',
  MDF_ORDER_LOCK_CONTENTION: 'Карточка МДФ занята',
  MDF_ORDER_SCOPE_LIMIT: 'Слишком большая область изменения',
  MDF_ENGINE_READ_ONLY: 'Движок МДФ доступен только для чтения',
  MDF_ORDER_CONFIRMATION_STALE: 'Состояние МДФ-доски изменилось',
};

// Digest identifying the confirmed preview: 64 lowercase-hex characters (sha256).
const MDF_CONFIRMATION_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const MDF_ORDER_CONFLICT_SOURCE_KIND_LABELS: Record<string, string> = {
  packet: 'Файл станка',
  bazisCutSet: 'Набор Базис',
  bath: 'Ванна',
};

const HIDDEN_CARD_NAME = 'карточка другого заказа';
const HIDDEN_OWNERS_NOTE = 'Есть карточки с заказами, которые вам не видны';

export type MdfOrderConflictPositionOutcome = 'surplus' | 'detached';

export interface MdfOrderConflictPositionView {
  orderId: number | null;
  detailId: number | null;
  before: number | null;
  after: number | null;
  cut?: number;
  laminated?: number;
  reserved?: number;
  outcome?: MdfOrderConflictPositionOutcome;
  line: string;
}

export interface MdfOrderConflictCardView {
  reason: string | null;
  sourceKind: string | null;
  sourceId: string | null;
  displayName: string | null;
  hiddenOwners: boolean;
  header: string;
  positions: MdfOrderConflictPositionView[];
}

export interface MdfOrderConflictViewModel {
  code: MdfOrderConflictCode;
  title: string;
  message: string;
  retryable: boolean;
  cards: MdfOrderConflictCardView[];
  hasHiddenOwners: boolean;
  hiddenOwnersNote: string | null;
  /**
   * 64-char lowercase-hex digest from details.mdfConfirmation.digest, when the
   * backend attached a confirmable preview to this 409. Present it means the
   * client may resend the identical request with header
   * X-MDF-Confirmation: <digest> to proceed despite the conflict.
   */
  confirmationDigest: string | null;
}

export function isMdfOrderConflictCode(code: unknown): code is MdfOrderConflictCode {
  return typeof code === 'string' && MDF_ORDER_CONFLICT_CODE_SET.has(code);
}

export function isMdfOrderConflictError(error: unknown): boolean {
  return isApiError(error) && isMdfOrderConflictCode(error.code);
}

export function isMdfOrderConflictRetryable(code: MdfOrderConflictCode): boolean {
  return MDF_ORDER_CONFLICT_RETRY_CODES.has(code);
}

/**
 * Detects one of the MDF board order-conflict codes on an error object and
 * builds a Russian-language view model ready to render (Modal.error content
 * or a simple retry message). Returns null when the error is not one of
 * these codes, so callers can fall back to their generic error handling.
 */
export function buildMdfOrderConflictViewModel(error: unknown): MdfOrderConflictViewModel | null {
  if (!isApiError(error) || !isMdfOrderConflictCode(error.code)) return null;

  const code = error.code;
  const rawCards = extractRawCards(error.details);
  const cards = rawCards.map(buildCardView);
  const hasHiddenOwners = cards.some((card) => card.hiddenOwners);

  return {
    code,
    title: MDF_ORDER_CONFLICT_TITLES[code],
    message: typeof error.message === 'string' ? error.message : '',
    retryable: isMdfOrderConflictRetryable(code),
    cards,
    hasHiddenOwners,
    hiddenOwnersNote: hasHiddenOwners ? HIDDEN_OWNERS_NOTE : null,
    confirmationDigest: extractConfirmationDigest(error.details),
  };
}

/**
 * Builds the one extra header the client must attach to resend the identical
 * request (same body, same If-Match/Idempotency-Key) so the backend applies
 * the previously previewed change instead of re-raising the same conflict.
 */
export function buildMdfConfirmationHeaders(digest: string): Record<string, string> {
  return { 'X-MDF-Confirmation': digest };
}

function extractConfirmationDigest(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  const mdfConfirmation = (details as { mdfConfirmation?: unknown }).mdfConfirmation;
  if (!mdfConfirmation || typeof mdfConfirmation !== 'object') return null;
  const digest = (mdfConfirmation as { digest?: unknown }).digest;
  return typeof digest === 'string' && MDF_CONFIRMATION_DIGEST_PATTERN.test(digest) ? digest : null;
}

function extractRawCards(details: unknown): unknown[] {
  if (!details || typeof details !== 'object') return [];
  const cards = (details as { cards?: unknown }).cards;
  return Array.isArray(cards) ? cards : [];
}

function buildCardView(rawCard: unknown): MdfOrderConflictCardView {
  const card = (rawCard && typeof rawCard === 'object' ? rawCard : {}) as Record<string, unknown>;
  const sourceKind = typeof card.sourceKind === 'string' ? card.sourceKind : null;
  const displayName = typeof card.displayName === 'string' && card.displayName.trim()
    ? card.displayName
    : null;
  const hiddenOwners = card.hiddenOwners === true;
  const reason = typeof card.reason === 'string' ? card.reason : null;
  const sourceId = typeof card.sourceId === 'string' ? card.sourceId : null;
  const rawPositions = Array.isArray(card.positions) ? card.positions : [];
  const positions = rawPositions.map(buildPositionView);

  return {
    reason,
    sourceKind,
    sourceId,
    displayName,
    hiddenOwners,
    header: formatCardHeader(sourceKind, displayName, hiddenOwners),
    positions,
  };
}

function formatCardHeader(
  sourceKind: string | null,
  displayName: string | null,
  hiddenOwners: boolean,
): string {
  const kindLabel = (sourceKind && MDF_ORDER_CONFLICT_SOURCE_KIND_LABELS[sourceKind]) || sourceKind || 'Карточка';
  const name = hiddenOwners ? HIDDEN_CARD_NAME : (displayName ?? HIDDEN_CARD_NAME);
  return `${kindLabel} «${name}»`;
}

function buildPositionView(rawPosition: unknown): MdfOrderConflictPositionView {
  const position = (rawPosition && typeof rawPosition === 'object' ? rawPosition : {}) as Record<string, unknown>;
  const orderId = typeof position.orderId === 'number' ? position.orderId : null;
  const detailId = typeof position.detailId === 'number' ? position.detailId : null;
  const before = typeof position.before === 'number' ? position.before : null;
  const after = typeof position.after === 'number' ? position.after : null;
  const cut = typeof position.cut === 'number' ? position.cut : undefined;
  const laminated = typeof position.laminated === 'number' ? position.laminated : undefined;
  const reserved = typeof position.reserved === 'number' ? position.reserved : undefined;
  const outcome = position.outcome === 'surplus' || position.outcome === 'detached'
    ? position.outcome
    : undefined;

  return {
    orderId,
    detailId,
    before,
    after,
    cut,
    laminated,
    reserved,
    outcome,
    line: formatPositionLine(detailId, before, after, cut, laminated, reserved, outcome),
  };
}

function formatPositionLine(
  detailId: number | null,
  before: number | null,
  after: number | null,
  cut?: number,
  laminated?: number,
  reserved?: number,
  outcome?: MdfOrderConflictPositionOutcome,
): string {
  const detailLabel = detailId !== null ? `#${detailId}` : '#—';
  const beforeLabel = before !== null ? String(before) : '—';
  const afterLabel = after !== null ? String(after) : 'удалена';
  let line = `деталь ${detailLabel}: было ${beforeLabel} → станет ${afterLabel}`;

  const stats = formatPositionStats(cut, laminated, reserved);
  if (stats) line += ` · ${stats}`;

  const outcomeNote = formatPositionOutcome(outcome);
  if (outcomeNote) line += ` — ${outcomeNote}`;

  return line;
}

function formatPositionStats(cut?: number, laminated?: number, reserved?: number): string | null {
  const parts: string[] = [];
  if (typeof cut === 'number') parts.push(`распилено ${cut}`);
  if (typeof laminated === 'number') parts.push(`закатано ${laminated}`);
  if (typeof reserved === 'number') parts.push(`в резерве ${reserved}`);
  return parts.length ? parts.join(', ') : null;
}

function formatPositionOutcome(outcome?: MdfOrderConflictPositionOutcome): string | null {
  if (outcome === 'surplus') return 'лишнее станет излишком';
  if (outcome === 'detached') return 'позиция выбудет из учёта (история сохранится)';
  return null;
}

/**
 * §5.4e keeps the caller's pending command open while the user decides on a
 * confirmable MDF preview: `open` shows the dialog; confirm resolves with the
 * identical command resent with the digest (its own result, including a
 * repeated preview), cancel resolves null. The caller's normal completion path
 * therefore runs exactly once, with the final outcome.
 */
export function awaitMdfConfirmation<T>(
  open: (handlers: { onConfirm: (digest: string) => void; onCancel: () => void }) => void,
  resend: (digest: string) => Promise<T>,
): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    let settled = false;
    open({
      onConfirm: (digest) => {
        if (settled) return;
        settled = true;
        resend(digest).then(resolve, reject);
      },
      onCancel: () => {
        if (settled) return;
        settled = true;
        resolve(null);
      },
    });
  });
}
