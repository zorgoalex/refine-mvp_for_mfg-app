import type { CurrentUser } from '../../../permissions/current-user';
import { isMdfBoardEvent, type MdfBoardResolvedEvent } from './mdf-board-event.types';

export interface MdfAutomationRulePin { ruleId: number; version: number }
export interface PinnedMdfAutomationInput {
  actor: CurrentUser;
  requestId: string;
  sourceIdempotencyKey: string;
  pins: readonly MdfAutomationRulePin[];
  events: readonly MdfBoardResolvedEvent[];
}

/** Shape validation is NOT evidence verification. The owning handler supplies
 * accepted, demand-fenced evidence and durable pins under its ordered locks.
 * Snapshot synchronously so an awaited query cannot change this batch's intent.
 */
export function snapshotPinnedMdfBatch(input: PinnedMdfAutomationInput): PinnedMdfAutomationInput {
  const positive = (n: number) => Number.isSafeInteger(n) && n > 0;
  const text = (value: string) => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
  const invalid = () => { throw new Error('MDF_INVALID_PINNED_BATCH'); };
  if (!text(input.requestId) || !text(input.sourceIdempotencyKey) || !input.actor
    || !/^[1-9]\d*$/.test(input.actor.id) || !text(input.actor.username)
    || !Array.isArray(input.pins) || input.pins.length > 1000
    || !Array.isArray(input.events) || input.events.length > 5000) invalid();
  const pinIds = new Set<number>();
  const pins = input.pins.map(pin => {
    if (!positive(pin.ruleId) || !positive(pin.version) || pinIds.has(pin.ruleId)) invalid();
    pinIds.add(pin.ruleId);
    return { ruleId: pin.ruleId, version: pin.version };
  });
  const orders = new Set<number>();
  const sources = new Map<string, string>();
  const entries = new Set<string>();
  const positions = new Map<number, { orderId: number; requiredQuantity: number }>();
  let lineCount = 0;
  const events = input.events.map(entry => {
    const { source, details } = entry.scope;
    const machine = source.kind === 'packet' || source.kind === 'bazisCutSet';
    const validId = typeof source.id === 'string' && (source.kind === 'packet'
      ? /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(source.id)
      : source.kind === 'bazisCutSet' ? /^[1-9]\d*$/.test(source.id)
      : source.kind === 'bath' && /^cut-result:[1-9]\d*$/.test(source.id));
    if (!positive(entry.orderId) || !validId || !text(source.id) || !isMdfBoardEvent(entry.eventType)
      || machine !== ['mdf.order_machine_files_present', 'mdf.board.completed'].includes(entry.eventType)
      || !Array.isArray(details) || details.length === 0) invalid();
    const sourceKey = `${source.kind}:${source.id}`;
    const entryKey = `${sourceKey}:${entry.orderId}`;
    if (entries.has(entryKey) || (sources.has(sourceKey) && sources.get(sourceKey) !== entry.eventType)) invalid();
    entries.add(entryKey);
    sources.set(sourceKey, entry.eventType);
    orders.add(entry.orderId);
    const detailIds = new Set<number>();
    return { eventType: entry.eventType, orderId: entry.orderId, scope: {
      source: { ...source },
      details: details.map(detail => {
        if (!positive(detail.detailId) || !positive(detail.requiredQuantity)
          || !Number.isSafeInteger(detail.eligibleQuantity) || detail.eligibleQuantity < 0
          || detailIds.has(detail.detailId) || ++lineCount > 5000) invalid();
        detailIds.add(detail.detailId);
        const previous = positions.get(detail.detailId);
        if (previous && (previous.orderId !== entry.orderId || previous.requiredQuantity !== detail.requiredQuantity)) invalid();
        positions.set(detail.detailId, { orderId: entry.orderId, requiredQuantity: detail.requiredQuantity });
        return { ...detail };
      }),
    } };
  });
  if (orders.size > 100 || sources.size > 250) invalid();
  return { actor: { ...input.actor }, requestId: input.requestId,
    sourceIdempotencyKey: input.sourceIdempotencyKey, pins, events };
}
