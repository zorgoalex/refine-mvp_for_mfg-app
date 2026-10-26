import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withRoundSuffix } from '../../../../api/orderReworkApi';
import {
  buildReworkRequest,
  createLatestGate,
  isReworkTargetAllowed,
  reworkActionLabel,
  reworkFormVersion,
  type ReworkStageOption,
} from './orderReworkModel';

const stages: ReworkStageOption[] = [
  { id: 1, name: 'Отрисован', sortOrder: 10, code: 'drawn', isActive: true },
  { id: 2, name: 'Распилен', sortOrder: 20, code: 'cut', isActive: true },
  { id: 3, name: 'Архив', sortOrder: 30, code: 'old', isActive: false },
  { id: 7, name: 'Упакован', sortOrder: 80, code: 'packed', isActive: true },
  { id: 8, name: 'Выдан', sortOrder: 90, code: 'issued', isActive: true },
  { id: 9, name: 'Завершено', sortOrder: 100, code: 'completed', isActive: true },
];
const byId = new Map(stages.map((s) => [s.id, s]));
const details = [
  { id: 11, detailNumber: 1, name: 'Фасад', productionStatusId: 7, productionRound: 1 },
  { id: 12, detailNumber: 2, name: 'Фасад', productionStatusId: 2, productionRound: 2 },
];
const reasons = [
  { reasonId: 1, code: 'workshop_defect', name: 'Брак цеха', requiresComment: false, sortOrder: 10 },
  { reasonId: 5, code: 'other', name: 'Другое', requiresComment: true, sortOrder: 90 },
];
const base = { details, stageById: byId, perRow: {}, comment: '', reasons };

describe('«Переделка» UI model', () => {
  it('suffixes a round after the original run only', () => {
    expect(withRoundSuffix('Распилен', 2)).toBe('Распилен ·2');
    expect(withRoundSuffix('Распилен', 1)).toBe('Распилен');
    expect(withRoundSuffix('Распилен', undefined)).toBe('Распилен');
  });

  it('labels the three actions', () => {
    expect(reworkActionLabel('return', null)).toBe('Вернуть в переделку');
    expect(reworkActionLabel('start_in_production', null)).toBe('Переделка деталей');
    expect(reworkActionLabel('extend', 3)).toBe('Добавить детали в переделку ·3');
  });

  it('allows only active stages earlier than the current one and before «Выдан» (backend rule)', () => {
    const packed = byId.get(7)!;
    expect(stages.filter((s) => isReworkTargetAllowed(s, packed, stages)).map((s) => s.id)).toEqual([1, 2]);
    expect(isReworkTargetAllowed(byId.get(1)!, undefined, stages)).toBe(false);
    const completed = byId.get(9)!;
    expect(stages.filter((s) => isReworkTargetAllowed(s, completed, stages)).map((s) => s.id)).toEqual([1, 2, 7]);
  });

  it('builds the command body: common stage, per-row override, reason and required comment', () => {
    const selected = new Set([11, 12]);
    expect(buildReworkRequest({ ...base, selected: new Set(), commonStage: 1, reasonId: 1, needsReason: true }))
      .toEqual({ ok: false, message: 'Выберите детали' });
    expect(buildReworkRequest({ ...base, selected, commonStage: undefined, reasonId: 1, needsReason: true }).ok).toBe(false);
    // Common «Распилен» is not earlier than detail 12's current «Распилен» → rejected until overridden.
    expect(buildReworkRequest({ ...base, selected, commonStage: 2, reasonId: 1, needsReason: true }).ok).toBe(false);
    expect(buildReworkRequest({ ...base, selected, commonStage: 2, perRow: { 12: 1 }, reasonId: 1, needsReason: true })).toEqual({
      ok: true,
      body: { reasonId: 1, comment: null, details: [{ detailId: 11, productionStatusId: 2 }, { detailId: 12, productionStatusId: 1 }] },
    });
    expect(buildReworkRequest({ ...base, selected, commonStage: 1, reasonId: undefined, needsReason: true }))
      .toEqual({ ok: false, message: 'Выберите причину' });
    expect(buildReworkRequest({ ...base, selected, commonStage: 1, reasonId: 5, needsReason: true, comment: '  ' }))
      .toEqual({ ok: false, message: 'Для этой причины нужен комментарий' });
    expect(buildReworkRequest({ ...base, selected, commonStage: 1, reasonId: 5, needsReason: true, comment: ' скол ' }))
      .toMatchObject({ ok: true, body: { reasonId: 5, comment: 'скол' } });
    // Extending the open round sends no reason.
    expect(buildReworkRequest({ ...base, selected: new Set([11]), commonStage: 1, reasonId: undefined, needsReason: false }))
      .toEqual({ ok: true, body: { details: [{ detailId: 11, productionStatusId: 1 }] } });
  });

  it('a form may act only with the version the rounds were read with, while the card shows the same version', () => {
    // Rounds read at N, card already re-read at N+1, rounds reload still in flight → blocked.
    expect(reworkFormVersion(5, 6)).toBeNull();
    // Rounds newer than the card (card re-read pending) → blocked too.
    expect(reworkFormVersion(7, 6)).toBeNull();
    expect(reworkFormVersion(undefined, 6)).toBeNull();
    // In sync → the form sends exactly that version.
    expect(reworkFormVersion(6, 6)).toBe(6);
  });

  it('drops a stale rounds response when a newer load started', () => {
    const gate = createLatestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });

  it('the panel and the reasons tab modules load (JSX/imports are valid)', async () => {
    expect(typeof (await import('./OrderReworkPanel')).OrderReworkPanel).toBe('function');
    expect(typeof (await import('../../../configuration/components/ReworkReasonsConfigTab')).ReworkReasonsConfigTab).toBe('function');
  }, 60_000); // first transform of the antd component graph is slow on a loaded host

  it('mounts the panel in the order card and gates actions by orders.rework', () => {
    const show = readFileSync(join(__dirname, '../../show.tsx'), 'utf8');
    expect(show).toContain('<OrderReworkPanel');
    const panel = readFileSync(join(__dirname, 'OrderReworkPanel.tsx'), 'utf8');
    // Actions use the backend-resolved capability (orders.rework + orders.update in scope).
    expect(panel).toContain('const canRework = order.canRework;');
    expect(panel).toContain("availability !== 'disabled_flag'");
    // Why the action is unavailable (MDF engine, cutover) is visible text, not a hover tooltip of a disabled button.
    expect(panel).toContain('{unavailableHint ? <Text type="secondary">{unavailableHint}</Text> : null}');
    // Phone: round actions go under the banner text, not beside it.
    expect(panel).toContain('action={canRework && !isMobile ? roundActions(openRound) : undefined}');
    expect(panel).toContain('description={canRework && isMobile ? roundActions(openRound) : undefined}');
    // The reason of any round (open or closed) can be set from the history (plan §8.5).
    // Forms carry the rounds snapshot version (never the card props version) and only when in sync.
    expect(panel).toContain('const formVersion = reworkFormVersion(order.version, version);');
    expect(panel).toContain('setReasonForm({ round: r, version: formVersion })');
    expect(panel).toContain('setReasonForm({ round, version: formVersion })');
    expect(panel).toContain('setStartForm({ version: formVersion })');
    expect(panel).toContain('const openedVersion = formVersion;');
    expect(panel).toContain('orderReworkApi.clarifyReason(orderId, reasonForm.round.roundNo, reasonForm.version');
    expect(panel).toContain('version={startForm.version}');
    expect(panel).not.toMatch(/version \}\)/);
    // Rounds newer than the card: the card is re-read once per version; explicit retry is offered.
    expect(panel).toContain('if (roundsVersion === null || roundsVersion <= version || cardRefreshRequested.current === roundsVersion) return;');
    expect(panel).toContain('Данные заказа обновляются…');
    // Overlapping loads: only the latest response is applied.
    expect(panel).toContain('if (!gate.isLatest(ticket)) return;');
    // 409 closes the form and re-reads the order.
    expect(panel).toContain('Данные обновлены — повторите действие.');
    expect(show).toContain('round={Number(detail.production_round ?? 1)}');
  });

  it('the card shows a new round without a reload: the stage cell redraws on a round change, other tabs re-read the order', () => {
    const show = readFileSync(join(__dirname, '../../show.tsx'), 'utf8');
    // The stage cell is redrawn only when its live version changes: the round must be part of it.
    const statusVersion = show.slice(show.indexOf('const statusVersion = JSON.stringify(['), show.indexOf(']);', show.indexOf('const statusVersion = JSON.stringify([')));
    expect(statusVersion).toContain('Number(detail?.production_round ?? 1)');
    // A live snapshot with a newer order version re-reads the card once per version.
    expect(show).toContain('const liveOrderVersion = orderDetailLiveState.loaded ? orderDetailLiveState.orderVersion : null;');
    // Re-reads go through the catch-up scheduler (one at a time, retried while behind; behaviour: orderVersionCatchUp.test).
    expect(show).toContain('orderVersionCatchUpRef.current?.update(liveOrderVersion, Number.isFinite(shownOrderVersion) ? shownOrderVersion : null);');
    expect(show).toContain('refetch: () => refetchOrderShowRef.current(),');
    expect(show).toContain('const orderVersionCatchUpActive = isWorkspaceTabActive && documentVisible && ordinaryReadActive;');
    expect(show).toContain('orderVersionCatchUpRef.current?.setActive(orderVersionCatchUpActive);');
  });
});
