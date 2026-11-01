import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withRoundSuffix } from '../../../../api/orderReworkApi';
import {
  buildReworkRequest,
  createLatestGate,
  isRedoFromAllowed,
  isReworkTargetAllowed,
  redoSummary,
  redoTarget,
  reworkActionLabel,
  reworkChain,
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

  it('«Переделка» 1.1: the round deadline is required for «Вернуть в переделку» and sent with the command', () => {
    const selected = new Set([11]);
    const base11 = { ...base, selected, commonStage: 1, reasonId: 1, needsReason: true };
    expect(buildReworkRequest({ ...base11, deadlineRequired: true, plannedCompletionDate: null }))
      .toEqual({ ok: false, message: 'Укажите срок готовности' });
    expect(buildReworkRequest({ ...base11, deadlineRequired: true, plannedCompletionDate: '2026-11-03' })).toEqual({
      ok: true,
      body: { reasonId: 1, comment: null, plannedCompletionDate: '2026-11-03', details: [{ detailId: 11, productionStatusId: 1 }] },
    });
    // In production / adding details: optional; without a date the body has none (the deadline is not changed).
    expect(buildReworkRequest({ ...base11, needsReason: false, deadlineRequired: false, plannedCompletionDate: null }))
      .toEqual({ ok: true, body: { details: [{ detailId: 11, productionStatusId: 1 }] } });
  });

  it('the start form pre-fills the deadline from the schedule suggestion and shows it on the banner and in the history', () => {
    const panel = readFileSync(join(__dirname, 'OrderReworkPanel.tsx'), 'utf8');
    const form = readFileSync(join(__dirname, 'ReworkStartModal.tsx'), 'utf8');
    expect(form).toContain('orderReworkApi.suggestDeadline(orderId, targets)');
    expect(form).toContain('label="Срок готовности"');
    expect(form).toContain("const deadlineRequired = action === 'return';");
    // Pre-fill only until edited by hand; adding details only moves the deadline later.
    expect(form).toContain('if (!plannedDateTouched) {');
    expect(form).toContain('next.suggestedDate > current');
    expect(form).toContain('Схема этапов и сроки не заполнена — укажите срок вручную');
    expect(panel).toContain(", срок: ${formatReworkDate(openRound.plannedCompletionDate)}");
    expect(panel).toContain("title: 'Срок'");
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
    // Actions use the backend-resolved capability (orders.rework + orders.update in scope); with the flag off no
    // action is offered (start, open round, history reason) — every command would answer 503.
    expect(panel).toContain("const canRework = order.canRework && availability !== 'disabled_flag';");
    expect(panel).toContain('const showStart = canRework && action !== null;');
    // The start/extend command is a «⋯» menu item of the card (reported up, opened on request); why it is
    // unavailable (MDF engine, cutover) is visible text in the panel.
    expect(panel).toContain('<Text type="secondary">{reworkActionLabel(action!, order.openRoundNo)}: {unavailableHint}</Text>');
    expect(panel).toContain('useEffect(() => { onStartActionChange?.(startMenu); }, [startMenuKey]);');
    expect(panel).not.toContain('onClick={() => formVersion !== null && setStartForm(');
    expect(show).toContain('onStartActionChange={setReworkStartMenu}');
    expect(show).toContain('startRequest={reworkStartRequest}');
    expect(show.match(/\.\.\.reworkMenuItems,/g)).toHaveLength(3); // NewLine, phone and desktop «⋯» menus
    expect(show.match(/key === 'rework-start'/g)?.length).toBe(3);
    // Phone: round actions go under the banner text, not beside it.
    expect(panel).toContain('action={canRework && !isMobile ? roundActions(openRound) : undefined}');
    expect(panel).toContain('description={canRework && isMobile ? roundActions(openRound) : undefined}');
    // The reason of any round (open or closed) can be set from the history (plan §8.5).
    // Forms carry the rounds snapshot version (never the card props version) and only when in sync.
    expect(panel).toContain('const formVersion = reworkFormVersion(order.version, version);');
    expect(panel).toContain('setReasonForm({ round: r, version: formVersion })');
    expect(panel).toContain('setReasonForm({ round, version: formVersion })');
    expect(panel).toContain('setStartForm({ version: formVersionNow })');
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

describe('«Переделка»: «what to redo» chain', () => {
  it('the chain starts after the initial stage, skips inactive stages and ends at «Выдан»', () => {
    expect(reworkChain(stages).map((s) => s.name)).toEqual(['Распилен', 'Упакован', 'Выдан']);
  });

  it('«redo from R» returns the detail to the active stage right before R', () => {
    expect(redoTarget(7, stages)).toBe(2); // redo «Упакован» → stays «Распилен» (inactive «Архив» skipped)
    expect(redoTarget(2, stages)).toBe(1); // redo from «Распилен» → back to «Отрисован», cut again
    expect(redoTarget(1, stages)).toBeUndefined(); // the initial stage cannot be redone
    expect(redoTarget(undefined, stages)).toBeUndefined();
  });

  it('a detail can redo only stages it has reached', () => {
    expect(isRedoFromAllowed(7, byId.get(7), stages)).toBe(true); // packed: redo packing
    expect(isRedoFromAllowed(2, byId.get(7), stages)).toBe(true);
    expect(isRedoFromAllowed(7, byId.get(2), stages)).toBe(false); // only cut: packing not reached
    expect(isRedoFromAllowed(8, byId.get(8), stages)).toBe(true); // issued: issue again (return to «Упакован»)
    expect(isRedoFromAllowed(9, byId.get(9), stages)).toBe(false); // after «Выдан» — not a return target
  });

  it('the summary names what stays done, what is redone and the next stage', () => {
    expect(redoSummary(7, stages, [7, 2])).toEqual({ kept: ['Распилен'], redo: ['Упакован'], becomes: 'Распилен', next: 'Упакован' });
    expect(redoSummary(2, stages, [8])).toEqual({ kept: [], redo: ['Распилен', 'Упакован', 'Выдан'], becomes: 'Отрисован', next: 'Распилен' });
    expect(redoSummary(1, stages, [7])).toBeNull();
  });
});

describe('«Переделка»: picking the status «Переделка» opens the rework form', () => {
  const src = (path: string) => readFileSync(join(__dirname, path), 'utf8');
  it('every order-status picker routes «Переделка» to the rework form, never to a plain status change', () => {
    expect(src('../OrderHeaderContextMenu.tsx')).toContain("if (reworkStatusIds.has(Number(status.id))) pickRework(header.order_id);");
    // While the status reference loads, a picker applies nothing («Переделка» could go unrecognised).
    for (const path of ['../sections/OrderStatusSection.tsx', '../sections/OrderBasicInfo.tsx']) {
      expect(src(path)).toContain('if (!reworkStatuses.ready) { reworkStatuses.explainNotReady(); return; }');
      expect(src(path)).toContain('if (reworkStatuses.ids.has(Number(value))) pickRework(header.order_id);');
    }
    const calendar = src('../../../calendar/components/CalendarBoard.tsx');
    expect(calendar).toContain("if (fieldName === 'order_status' && !reworkStatuses.ready) {");
    expect(calendar).toContain("if (fieldName === 'order_status' && reworkStatuses.ids.has(Number(statusId))) {");
    const board = src('../../../orderStatusBoard/OrderStatusBoardPage.tsx');
    expect(board).toContain("if (viewState.view === 'order' && !reworkStatuses.ready) {");
    expect(board).toContain("if (viewState.view === 'order' && reworkStatuses.ids.has(Number(targetStatusId))) {");
    expect(src('../../../../ui-variant/shellRegistry.tsx')).toContain('<ReworkStartHost />');
    expect(src('../../../../App.tsx')).not.toContain('ReworkStartHost'); // App.tsx imports no page module statically
    // The order form opens it only without unsaved edits and re-reads the order afterwards.
    const pick = src('useOrderFormReworkPick.ts');
    expect(pick).toContain('if (storeApi.getState().isDirty) {');
    expect(pick).toContain('void refresh(orderId, result.version)');
    expect(pick).toContain('getOrder: (orderId) => fetchOrderAfterRework(orderId),');
    // The host: one form instance per opening, late answers dropped (see loadReworkForm.test.ts).
    const host = src('ReworkStartHost.tsx');
    expect(host).toContain('key={ticket}');
    expect(host).toContain('isCurrent: () => gate.isLatest(ticket),');
    // Closing and busy belong to the form's ticket: a late command answer never closes or blocks a newer form.
    expect(host).toContain('if (!gate.isLatest(ticket)) return;');
    expect(host).toContain('busy={busyTicket === ticket}');
    expect(host).toContain('request.onDone?.(result);');
  });

  it('the status is recognised by its code, and the code is read with the status reference', () => {
    expect(src('../../../../utils/dataProvider.ts')).toMatch(/order_statuses: \[\n\s+"order_status_id",\n\s+"order_status_name",\n\s+"order_status_code",/);
    expect(src('useReworkOrderStatusIds.ts')).toContain('isReworkOrderStatus({ code: status.order_status_code as string | null })');
  });
});
