import type {
  BazisCutCompositionAssignmentChange,
  BazisCutCompositionBlocker,
  BazisCutCompositionConfirmRequest,
  BazisCutCompositionDesiredRow,
  BazisCutCompositionPreservedAllocation,
  BazisCutCompositionPreviewRequest,
  BazisCutCompositionPreviewResponse,
  BazisCutCompositionRetainedPhysical,
  BazisCutSetCardDto,
  MdfCompositionUnavailableReason,
} from '../../api/bazisCutApi';

/** One row-composition edit, applied against the set's CURRENT details to build the
 * complete desiredRows list the backend expects (an omitted row is deleted). */
export type CompositionRowEdit =
  | { kind: 'quantity'; detailId: number; quantity: number }
  | { kind: 'delete'; detailId: number }
  | { kind: 'deleteMany'; detailIds: number[] };

/** Narrow, structural view of a set detail sufficient to build desiredRows;
 * BazisCutSetDetailDto satisfies this. */
export interface CompositionRowSource {
  bazisCutSetDetailId: number;
  quantity: number;
}

/** Narrow, structural view used to enrich an assignment-change line with names;
 * BazisCutSetDetailDto satisfies this. */
export interface CompositionDetailLookup extends CompositionRowSource {
  sourceOrderName?: string | null;
  sourceOrderFullNumber?: string | null;
  partName?: string | null;
}

/** Builds the COMPLETE desired-rows list for a composition preview/confirm request: every
 * current, ELIGIBLE detail stays with its current quantity, except the edit target(s).
 * Setting a row's quantity to 0 (or below) is equivalent to deleting it, since the backend
 * requires quantity >= 1 per row and treats an omitted row as removed.
 *
 * `eligibleRowIds` (server-resolved: set.mdfComposition.eligibleRowIds) gates which rows
 * may appear at all — the backend only accepts ordinary MDF rows here; HDF rows, non-MDF
 * materials and cut-disabled rows are NOT eligible and must never be included, since the
 * server preserves them raw on its own. A row missing from `eligibleRowIds` is excluded
 * even if it is also the edit target (the caller is expected to disable edit/delete UI for
 * non-eligible rows so this should not normally happen, but this function never trusts
 * that and filters unconditionally). */
export function buildCompositionRows(
  details: readonly CompositionRowSource[],
  edit: CompositionRowEdit,
  eligibleRowIds: readonly string[],
): BazisCutCompositionDesiredRow[] {
  const eligibleIds = new Set(eligibleRowIds);
  const deletedIds = new Set<number>(
    edit.kind === 'delete' ? [edit.detailId] : edit.kind === 'deleteMany' ? edit.detailIds : [],
  );
  const rows: BazisCutCompositionDesiredRow[] = [];
  for (const detail of details) {
    const rowId = String(detail.bazisCutSetDetailId);
    if (!eligibleIds.has(rowId)) continue;
    if (deletedIds.has(detail.bazisCutSetDetailId)) continue;
    const quantity = edit.kind === 'quantity' && edit.detailId === detail.bazisCutSetDetailId
      ? edit.quantity
      : detail.quantity;
    if (quantity < 1) continue;
    rows.push({ rowId, quantity });
  }
  return rows;
}

/** Whether a set detail (by its bazisCutSetDetailId) is eligible for the composition
 * command; used to disable quantity-edit/delete/bulk-select controls in composition mode
 * for HDF rows, non-MDF materials and cut-disabled rows, which the server preserves raw
 * and never accepts inside desiredRows. */
export function isEligibleForComposition(bazisCutSetDetailId: number, eligibleRowIds: readonly string[]): boolean {
  return eligibleRowIds.includes(String(bazisCutSetDetailId));
}

/** Tooltip shown on disabled quantity-edit/delete/bulk-select controls for a row that is
 * not eligible for the composition command (see isEligibleForComposition). */
export const COMPOSITION_INELIGIBLE_TOOLTIP =
  'Позиция не участвует в МДФ-учёте (ХДФ или другой материал) — её нельзя менять через состав набора';

/** Russian explanation shown next to disabled edit/delete controls when the new MDF
 * engine reports the set's composition command as unavailable. */
export function compositionUnavailableText(reason: MdfCompositionUnavailableReason | null): string {
  switch (reason) {
    case 'MDF_ENGINE_NOT_ACTIVE':
      return 'Производственный учёт ещё не включён — изменение состава набора недоступно';
    case 'MDF_ENGINE_READ_ONLY':
      return 'Производственный учёт временно доступен только для чтения';
    case 'MDF_SOURCE_NOT_REGISTERED':
      return 'Набор ещё не зарегистрирован в производственном учёте';
    case 'MDF_PUBLICATION_PENDING':
      return 'Набор ещё обрабатывается производственным учётом — обновите страницу через минуту';
    case 'MDF_SOURCE_ISSUES':
      return 'В данных набора обнаружены несоответствия производственного учёта — обратитесь к администратору';
    case 'MDF_PARTIAL_ACCESS':
      return 'В наборе есть детали заказов, к которым у вас нет доступа';
    default:
      return 'Изменение состава набора сейчас недоступно';
  }
}

export interface CompositionPreviewDisplay {
  status: 'ready' | 'unchanged' | 'blocked';
  /** true only for a 'ready' preview that actually changes assignments. */
  hasChanges: boolean;
  assignmentLines: string[];
  retainedLines: string[];
  preservedLines: string[];
  blockerLines: string[];
}

/** Builds a display model out of a raw composition-preview response. `details` (the set's
 * details BEFORE the edit) is optional and only used to enrich assignment-change lines with
 * order/part names when the row is still present; falls back to bare ids otherwise. */
export function describeCompositionPreview(
  preview: BazisCutCompositionPreviewResponse,
  details: readonly CompositionDetailLookup[] = [],
): CompositionPreviewDisplay {
  if (preview.status === 'blocked') {
    return {
      status: 'blocked',
      hasChanges: false,
      assignmentLines: [],
      retainedLines: [],
      preservedLines: [],
      blockerLines: preview.blockers.map(describeCompositionBlocker),
    };
  }
  const detailsByRowId = new Map(details.map((detail) => [String(detail.bazisCutSetDetailId), detail]));
  const assignmentLines = preview.assignmentChanges.map((change) => describeAssignmentChange(change, detailsByRowId));
  return {
    status: preview.status,
    hasChanges: preview.status === 'ready' && assignmentLines.length > 0,
    assignmentLines,
    retainedLines: preview.retainedPhysical.map(describeRetainedPhysical),
    preservedLines: preview.preservedAllocations.map(describePreservedAllocation),
    blockerLines: [],
  };
}

function describeAssignmentChange(
  change: BazisCutCompositionAssignmentChange,
  detailsByRowId: Map<string, CompositionDetailLookup>,
): string {
  const detail = detailsByRowId.get(change.rowId);
  const orderLabel = detail?.sourceOrderName || detail?.sourceOrderFullNumber || `№${change.orderId}`;
  const partLabel = detail?.partName || `деталь №${change.detailId}`;
  return `Заказ ${orderLabel}, ${partLabel}: ${change.before} → ${change.after}`;
}

function describeRetainedPhysical(item: BazisCutCompositionRetainedPhysical): string {
  const stageLabel = item.stage === 'laminated' ? 'Ламинирование' : 'Распил';
  const reworkSuffix = item.rework ? ' (переделка)' : '';
  return `${stageLabel} ${item.quantity} шт. сохраняется (заказ №${item.orderId}, деталь №${item.detailId})${reworkSuffix}`;
}

function describePreservedAllocation(item: BazisCutCompositionPreservedAllocation): string {
  const stateLabel = item.state === 'consumed' ? 'израсходовано' : 'зарезервировано';
  return `Ванна №${item.bathId}: ${item.quantity} шт. ${stateLabel}`;
}

function describeCompositionBlocker(blocker: BazisCutCompositionBlocker): string {
  const location = blocker.position
    ? ` (позиция ${blocker.position})`
    : blocker.sourceId
      ? ` (источник ${blocker.sourceId})`
      : blocker.allocationId
        ? ` (резерв ${blocker.allocationId})`
        : '';
  return `${blocker.code}${location}`;
}

/** Idempotency-Key charset the backend requires for the composition confirm command;
 * stricter than the generic 8..200-char rule used by the legacy bazis-cut commands. */
const COMPOSITION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function generateCompositionIdempotencyKey(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `bazis-composition:${random}`;
}

/** Sequences preview -> confirm for one composition edit attempt, and guards against a
 * STALE async completion overwriting a newer, in-progress attempt (e.g. the user opens a
 * preview for deletion A, cancels, then opens deletion B before A's late HTTP response
 * arrives).
 *
 * Every preview attempt gets a `generation` token from beginAttempt()/reset(); a caller
 * must pass that same token back into registerPreview(), and only the attempt matching the
 * CURRENT generation is allowed to register — a late response from a superseded attempt is
 * silently ignored (registerPreview returns false) instead of overwriting the builder's
 * state. buildConfirmRequest() hands its caller the generation the confirm belongs to (the
 * one that produced the currently registered preview), so the caller can likewise ignore a
 * stale confirm completion via isCurrentAttempt() after its own await. reset()/invalidate()
 * (modal close/unmount, or the requested edit changing) bump the generation so anything
 * still in flight can never be applied again.
 *
 * Also reuses exactly ONE idempotency key across repeated confirm calls for the SAME
 * preview (e.g. retrying after a network error or a transient failure), so a retry of
 * confirm is a true replay rather than a fresh command. A new key is generated only once a
 * fresh preview is registered, since a changed preview means a materially different
 * command. */
export class CompositionCommandBuilder {
  private request: BazisCutCompositionPreviewRequest | null = null;
  private digest: string | null = null;
  private idempotencyKey: string | null = null;
  private generation = 0;

  /** Starts a new preview attempt (about to issue a fresh HTTP round-trip) and returns its
   * generation token; pass it to registerPreview()/isCurrentAttempt() so a late completion
   * from an earlier, superseded attempt is ignored rather than applied. */
  beginAttempt(): number {
    this.generation += 1;
    return this.generation;
  }

  /** The generation of the attempt that is currently allowed to complete. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Whether `generation` (captured earlier from beginAttempt()/reset()/buildConfirmRequest())
   * is still the current attempt — false once a newer attempt has started or the builder was
   * reset/invalidated since. */
  isCurrentAttempt(generation: number): boolean {
    return generation === this.generation;
  }

  buildPreviewRequest(
    expectedVersion: string,
    sourceToken: string,
    desiredRows: BazisCutCompositionDesiredRow[],
  ): BazisCutCompositionPreviewRequest {
    return { expectedVersion, sourceToken, desiredRows };
  }

  /** Records the outcome of a preview call IF `generation` is still the current attempt
   * (see isCurrentAttempt); a stale generation is ignored — this returns false and leaves
   * whatever preview is already registered untouched. A 'blocked' response (or a stale/
   * ignored one) makes this builder non-confirmable until a fresh 'ready'/'unchanged'
   * preview is registered. */
  registerPreview(
    generation: number,
    request: BazisCutCompositionPreviewRequest,
    response: BazisCutCompositionPreviewResponse,
  ): boolean {
    if (!this.isCurrentAttempt(generation)) return false;
    this.request = request;
    this.digest = response.status === 'blocked' ? null : response.previewDigest;
    this.idempotencyKey = null;
    return true;
  }

  get confirmable(): boolean {
    return this.request !== null && this.digest !== null;
  }

  /** Builds the confirm request from the CURRENTLY REGISTERED preview (never a stale one,
   * since registerPreview only ever applies a current-generation result), plus the
   * generation it belongs to — the caller checks isCurrentAttempt(generation) after its own
   * async confirm call resolves, to ignore a stale completion (e.g. the modal was closed or
   * a new request opened while confirm was in flight). */
  buildConfirmRequest(): { request: BazisCutCompositionConfirmRequest; idempotencyKey: string; generation: number } {
    if (!this.request || !this.digest) {
      throw new Error('Нет актуального предпросмотра для подтверждения');
    }
    if (!this.idempotencyKey || !COMPOSITION_IDEMPOTENCY_KEY_PATTERN.test(this.idempotencyKey)) {
      this.idempotencyKey = generateCompositionIdempotencyKey();
    }
    return {
      request: { ...this.request, expectedDigest: this.digest },
      idempotencyKey: this.idempotencyKey,
      generation: this.generation,
    };
  }

  /** Clears any registered preview/confirm state and starts a fresh attempt generation —
   * for opening a brand new composition-edit request. Returns the new generation. */
  reset(): number {
    this.request = null;
    this.digest = null;
    this.idempotencyKey = null;
    this.generation += 1;
    return this.generation;
  }

  /** Bumps the generation WITHOUT touching registered preview/confirm state, so any
   * response still in flight from the just-superseded attempt can never be applied. Use on
   * modal close/unmount (reset() is for starting a new request; invalidate() is for
   * abandoning one without starting another). */
  invalidate(): void {
    this.generation += 1;
  }
}

/** Merges a mutation response's set (rename, quantity edit, delete, …) onto the previously
 * known set, working around the backend returning `mdfComposition` on GET responses ONLY:
 * a mutation response's `set.mdfComposition` is always absent, even when the set is
 * actively in composition mode.
 *
 * Naively calling `setSet(result.set)` after a mutation would make `mdfComposition`
 * disappear from the page's state, flipping `compositionMode` off and flashing the legacy
 * edit/delete controls back for a set that is still on the new MDF engine. Instead, when
 * the mutation dropped `mdfComposition` but the set was previously known to have one, this
 * keeps composition mode ACTIVE (so legacy controls never reappear) while marking it
 * `available: false` so composition controls stay disabled until the caller reloads the set
 * via GET and gets the real, current readiness/eligibility back. */
export function mergeSetAfterMutation(
  previous: BazisCutSetCardDto | null,
  mutated: BazisCutSetCardDto,
): BazisCutSetCardDto {
  if (mutated.mdfComposition || !previous?.mdfComposition) return mutated;
  return { ...mutated, mdfComposition: { ...previous.mdfComposition, available: false } };
}

/** Whether the set returned by a mutation needs a follow-up GET reload to restore
 * `mdfComposition` (composition mode was active before the mutation but the mutation
 * response — being GET-only for that field — omitted it). Pairs with
 * mergeSetAfterMutation(): call this on the PRE-mutation set and the mutation's raw
 * response (before merging) to decide whether to await the reload. */
export function needsCompositionReload(previous: BazisCutSetCardDto | null, mutated: BazisCutSetCardDto): boolean {
  return Boolean(previous?.mdfComposition) && !mutated.mdfComposition;
}
