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
};

const MDF_ORDER_CONFLICT_SOURCE_KIND_LABELS: Record<string, string> = {
  packet: 'Файл станка',
  bazisCutSet: 'Набор Базис',
  bath: 'Ванна',
};

const HIDDEN_CARD_NAME = 'карточка другого заказа';
const HIDDEN_OWNERS_NOTE = 'Есть карточки с заказами, которые вам не видны';

export interface MdfOrderConflictPositionView {
  orderId: number | null;
  detailId: number | null;
  before: number | null;
  after: number | null;
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
  };
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

  return {
    orderId,
    detailId,
    before,
    after,
    line: formatPositionLine(detailId, before, after),
  };
}

function formatPositionLine(
  detailId: number | null,
  before: number | null,
  after: number | null,
): string {
  const detailLabel = detailId !== null ? `#${detailId}` : '#—';
  const beforeLabel = before !== null ? String(before) : '—';
  const afterLabel = after !== null ? String(after) : 'удалена';
  return `деталь ${detailLabel}: было ${beforeLabel} → станет ${afterLabel}`;
}
