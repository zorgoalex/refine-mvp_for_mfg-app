import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { StatusAutomationRule } from './status-automation.types';
import type { PinnedMdfAutomationInput } from './mdf-pinned-batch';
const mocks = vi.hoisted(() => ({ load: vi.fn(), current: vi.fn(), all: vi.fn(), state: vi.fn(),
  details: vi.fn(), order: vi.fn(), production: vi.fn(), audit: vi.fn(), resolve: vi.fn(), shadow: vi.fn() }));
vi.mock('../adapters/pg-status-automation-repository', () => ({
  loadRulesForPinnedExecution: mocks.load, listEnabledRulesForEvent: mocks.current,
  listEnabledRulesForManualRefresh: mocks.all, loadOrderAutomationState: mocks.state,
}));
vi.mock('../adapters/pg-mdf-board-event-repository', () => ({ loadMdfBoardEvents: mocks.resolve }));
vi.mock('../../mdf-board/application/mdf-shadow', () => ({ markMdfShadowSource: mocks.shadow }));
vi.mock('../../production-actions/adapters/pg-production-action-repository', () => ({
  changeDetailsProductionStatusFromAutomationInTransaction: mocks.details,
  changeOrderStatusFromAutomationInTransaction: mocks.order,
  changeProductionStatusFromAutomationInTransaction: mocks.production,
}));
vi.mock('../../../common/audit/audit.service', () => ({ auditService: { record: mocks.audit } }));
import { dispatchMdfBoardEvent, evaluateAllStatusAutomationRulesForOrder, evaluateProductionCompositionAutomation,
  executePinnedMdfAutomation } from './status-automation-runtime';

const rule = (overrides: Partial<StatusAutomationRule> = {}): StatusAutomationRule => ({
  id: 17, version: 2, name: 'E2E pinned', eventType: 'mdf.board.completed',
  actionType: 'change_details_production_status', targetStatusId: 3,
  priority: 10, isEnabled: true, conditions: {}, actionConfig: { detailTransitionMode: 'set_exact' }, ...overrides,
});
const input = (): PinnedMdfAutomationInput => ({
  actor: { id: '1', username: 'e2e-pinned', role: 'admin', roleId: 1, permissions: [] },
  requestId: 'e2e-request', sourceIdempotencyKey: 'e2e-job', pins: [{ ruleId: 17, version: 2 }],
  events: [{ eventType: 'mdf.board.completed', orderId: 1, scope: {
    source: { kind: 'packet', id: '11111111-1111-1111-1111-111111111111' },
    details: [{ detailId: 11, requiredQuantity: 10, eligibleQuantity: 10 },
      { detailId: 12, requiredQuantity: 10, eligibleQuantity: 9 }],
  } }],
});
const tx = () => ({ query: vi.fn(), raw: {} }) as unknown as TransactionClient;
describe('pinned MDF execution boundary', () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'true');
    vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'false');
    mocks.load.mockResolvedValue([rule()]); mocks.current.mockResolvedValue([]); mocks.all.mockResolvedValue([]);
    mocks.state.mockResolvedValue({ orderId: 1, orderStatusId: 4, productionStatusId: 3,
      productionSummary: { detailCount: 2, unassignedCount: 0, statusIds: [3] },
      paymentStatusId: 1, finalAmount: 100, paidAmount: 100, source: 'manual' });
    mocks.details.mockResolvedValue({ status: 'executed' }); mocks.order.mockResolvedValue({ status: 'executed' });
    mocks.audit.mockResolvedValue('audit');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('runs exact pins only, own eligible positions, forced advance-only and stable audit/outbox key', async () => {
    mocks.load.mockResolvedValue([rule(), rule({ id: 99, priority: 0 })]);
    const transaction = tx(), batch = input();
    expect(await executePinnedMdfAutomation(transaction, batch)).toMatchObject({ status: 'evaluated', selectedRuleCount: 1 });
    expect(mocks.details).toHaveBeenCalledOnce();
    expect(mocks.details).toHaveBeenCalledWith(transaction, 1, 3, expect.objectContaining({
      actor: batch.actor, requestId: batch.requestId, ruleId: 17,
      mdfBoardScope: batch.events[0].scope,
      outboxIdempotencyKey: 'e2e-job:packet:11111111-1111-1111-1111-111111111111:mdf.board.completed:order-1:automation-17:order-1',
    }), 'advance_only');
    expect(mocks.state).toHaveBeenCalledWith(transaction, 1, [11]);
    expect(mocks.audit).toHaveBeenCalledWith(transaction, expect.objectContaining({
      event: 'status_automation.rule_applied', relatedOrderId: 1,
      metadata: expect.objectContaining({ ruleVersion: 2 }),
    }));
    expect(mocks.current).not.toHaveBeenCalled(); expect(mocks.all).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.shadow).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', [], null], ['disabled', [rule({ isEnabled: false, version: 3 })], 3],
    ['version_changed', [rule({ version: 3 })], 3],
  ] as const)('audits %s once without replacing the pin', async (reason, definitions, currentVersion) => {
    mocks.load.mockResolvedValue(definitions);
    const transaction = tx();
    const result = await executePinnedMdfAutomation(transaction, input());
    expect(result.skippedPins).toEqual([{ ruleId: 17, version: 2, reason: `pinned_rule_${reason}` }]);
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(transaction, expect.objectContaining({
      event: 'status_automation.rule_skipped', entityId: 17, actorUserId: '1', requestId: 'e2e-request',
      relatedOrderId: 1, relatedEntities: [{ entityType: 'order', entityId: 1 }],
      metadata: expect.objectContaining({ reason: `pinned_rule_${reason}`, expectedRuleVersion: 2, currentRuleVersion: currentVersion }),
    }));
  });

  it('uses pinned priority, and excludes newly created higher-priority rules', async () => {
    const batch = input(); batch.pins = [...batch.pins, { ruleId: 18, version: 1 }];
    mocks.load.mockResolvedValue([rule(), rule({ id: 18, version: 1, priority: 1, targetStatusId: 7 }),
      rule({ id: 99, priority: -1 })]);
    await executePinnedMdfAutomation(tx(), batch);
    expect(mocks.details).toHaveBeenCalledOnce();
    expect(mocks.details.mock.calls[0][2]).toBe(7);
  });

  it.each([true, false])('nested composition uses only downstream pins (included=%s)', async included => {
    const transaction = tx(), batch = input();
    const downstream = rule({ id: 18, eventType: 'order.production_status_changed', actionType: 'change_order_status' });
    if (included) batch.pins = [...batch.pins, { ruleId: 18, version: 2 }];
    mocks.load.mockResolvedValue([rule(), downstream]); mocks.current.mockResolvedValue([downstream]);
    mocks.details.mockImplementation(async () => {
      await evaluateProductionCompositionAutomation(transaction, { ...batch, orderId: 1 });
      return { status: 'executed' };
    });
    await executePinnedMdfAutomation(transaction, batch);
    expect(mocks.order).toHaveBeenCalledTimes(included ? 1 : 0);
    expect(mocks.current).not.toHaveBeenCalled();
  });

  it('empty pins never fall back to current rules', async () => {
    await executePinnedMdfAutomation(tx(), { ...input(), pins: [] });
    expect(mocks.details).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled();
  });
  it.each(['mdf.order_machine_files_present', 'mdf.board.completed', 'mdf.board.baths',
    'mdf.board.baths_ready', 'mdf.board.baths_laminated'] as const)('accepts own scoped %s', async eventType => {
    const batch = input(); batch.events[0].eventType = eventType;
    batch.events[0].scope.source = eventType.startsWith('mdf.board.baths')
      ? { kind: 'bath', id: 'cut-result:42' } : { kind: 'bazisCutSet', id: '42' };
    mocks.load.mockResolvedValue([rule({ eventType })]);
    await executePinnedMdfAutomation(tx(), batch);
    expect(mocks.details).toHaveBeenCalledOnce();
    expect(mocks.details.mock.calls[0][3].mdfBoardScope.source).toEqual(batch.events[0].scope.source);
  });
  it('incomplete position never advances', async () => {
    const batch = input(); batch.events[0].scope.details[0].eligibleQuantity = 9;
    await executePinnedMdfAutomation(tx(), batch);
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.audit.mock.calls[0][1].metadata.reason).toBe('mdf_quantity_incomplete');
  });
  it('feature disabled performs no queries or writes', async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'false');
    expect(await executePinnedMdfAutomation(tx(), input())).toMatchObject({ status: 'disabled' });
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it('failed action does not poison retry on the same transaction wrapper', async () => {
    const transaction = tx(); mocks.details.mockRejectedValueOnce(new Error('rollback'));
    await expect(executePinnedMdfAutomation(transaction, input())).rejects.toThrow('rollback');
    await executePinnedMdfAutomation(transaction, input());
    expect(mocks.details).toHaveBeenCalledTimes(2);
  });
  it('audit failure restores context; subsequent ordinary automation reads current rules', async () => {
    const transaction = tx(); mocks.audit.mockRejectedValueOnce(new Error('audit failed'));
    await expect(executePinnedMdfAutomation(transaction, input())).rejects.toThrow('audit failed');
    await evaluateProductionCompositionAutomation(transaction, { ...input(), orderId: 1 });
    expect(mocks.current).toHaveBeenCalledOnce();
  });
  it('definition load failure restores context before retry', async () => {
    const transaction = tx(); mocks.load.mockRejectedValueOnce(new Error('load failed'));
    await expect(executePinnedMdfAutomation(transaction, input())).rejects.toThrow('load failed');
    await executePinnedMdfAutomation(transaction, input());
    expect(mocks.details).toHaveBeenCalledOnce();
  });
  it('preserves the outer transaction recursion guard while isolating this execution', async () => {
    const transaction = tx(), batch = input();
    const downstream = rule({ id: 18, eventType: 'order.production_status_changed', actionType: 'change_order_status' });
    mocks.current.mockResolvedValue([downstream]);
    await evaluateProductionCompositionAutomation(transaction, { ...batch, orderId: 1 });
    batch.pins = [...batch.pins, { ruleId: 18, version: 2 }];
    mocks.load.mockResolvedValue([rule(), downstream]);
    mocks.details.mockImplementation(async () => {
      await evaluateProductionCompositionAutomation(transaction, { ...batch, orderId: 1 });
      return { status: 'executed' };
    });
    await executePinnedMdfAutomation(transaction, batch);
    await evaluateProductionCompositionAutomation(transaction, { ...batch, orderId: 1 });
    expect(mocks.order).toHaveBeenCalledTimes(2); // outer once, isolated pinned once; outer restored
  });
  it('rejects a concurrent boundary even while its definitions are still loading', async () => {
    const transaction = tx(); let resume!: (value: StatusAutomationRule[]) => void;
    mocks.load.mockReturnValueOnce(new Promise<StatusAutomationRule[]>(resolve => { resume = resolve; }));
    const pending = executePinnedMdfAutomation(transaction, input());
    await expect(executePinnedMdfAutomation(transaction, input())).rejects.toThrow('MDF_PINNED_EXECUTION_REENTRANT');
    resume([rule()]); await pending;
    expect(mocks.details).toHaveBeenCalledOnce();
  });
  it.each(['manual', 'legacy', 'reentrant'] as const)('blocks %s bypass before legacy effects', async path => {
    const transaction = tx(), batch = input();
    mocks.details.mockImplementation(async () => {
      if (path === 'manual') await evaluateAllStatusAutomationRulesForOrder(transaction, { ...batch, orderId: 1 });
      if (path === 'legacy') await dispatchMdfBoardEvent(transaction, { ...batch, source: batch.events[0].scope.source });
      if (path === 'reentrant') await executePinnedMdfAutomation(transaction, batch);
    });
    await expect(executePinnedMdfAutomation(transaction, batch)).rejects.toThrow('MDF_PINNED_');
    expect(mocks.all).not.toHaveBeenCalled(); expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.shadow).not.toHaveBeenCalled();
  });
  it('snapshots scope, pins and actor before awaited definition loading', async () => {
    const batch = input();
    mocks.load.mockImplementation(async () => {
      batch.events[0].scope.details[0].detailId = 999; batch.events[0].orderId = 999;
      batch.pins[0].version = 99; batch.actor.id = '99'; return [rule()];
    });
    await executePinnedMdfAutomation(tx(), batch);
    expect(mocks.state).toHaveBeenCalledWith(expect.anything(), 1, [11]);
    expect(mocks.details.mock.calls[0][3].actor.id).toBe('1');
  });
  it.each(['duplicate pin', 'fraction', 'negative', 'duplicate detail', 'duplicate event',
    'wrong pair', 'owner conflict', 'demand conflict'] as const)('rejects %s before any effects', async failure => {
    const batch = input();
    if (failure === 'duplicate pin') batch.pins = [...batch.pins, batch.pins[0]];
    if (failure === 'fraction') batch.events[0].scope.details[0].requiredQuantity = 0.5;
    if (failure === 'negative') batch.events[0].scope.details[0].eligibleQuantity = -1;
    if (failure === 'duplicate detail') batch.events[0].scope.details.push(batch.events[0].scope.details[0]);
    if (failure === 'duplicate event') batch.events = [...batch.events, batch.events[0]];
    if (failure === 'wrong pair') batch.events[0].eventType = 'mdf.board.baths_ready';
    if (failure === 'owner conflict' || failure === 'demand conflict') {
      const other = structuredClone(batch.events[0]); other.scope.source.id = '22222222-2222-2222-2222-222222222222';
      if (failure === 'owner conflict') other.orderId = 2;
      else other.scope.details[0].requiredQuantity = 11;
      batch.events = [...batch.events, other];
    }
    await expect(executePinnedMdfAutomation(tx(), batch)).rejects.toThrow('MDF_INVALID_PINNED_BATCH');
    expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.details).not.toHaveBeenCalled();
  });

  describe('live command connection', () => {
    const liveInput = () => ({ ...input(), source: input().events[0].scope.source });
    beforeEach(() => {
      vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'true');
      mocks.all.mockResolvedValue([rule()]); mocks.resolve.mockResolvedValue(input().events);
    });

    it.each(['mdf.order_machine_files_present', 'mdf.board.completed', 'mdf.board.baths',
      'mdf.board.baths_ready', 'mdf.board.baths_laminated'] as const)('connects %s exactly once through server scope', async eventType => {
      const batch = input(); batch.events[0].eventType = eventType;
      if (eventType.startsWith('mdf.board.baths')) batch.events[0].scope.source = { kind: 'bath', id: 'cut-result:42' };
      mocks.all.mockResolvedValue([rule({ eventType })]); mocks.load.mockResolvedValue([rule({ eventType })]);
      mocks.resolve.mockResolvedValue(batch.events);
      const transaction = tx(), command = { ...batch, source: batch.events[0].scope.source };
      await dispatchMdfBoardEvent(transaction, command);
      expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(transaction, command.source);
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(transaction, [17]);
      expect(mocks.details).toHaveBeenCalledOnce(); expect(mocks.current).not.toHaveBeenCalled();
      expect(mocks.shadow).toHaveBeenCalledExactlyOnceWith(transaction, command);
      expect(mocks.audit.mock.calls.at(-1)?.[1].metadata).toMatchObject({ executionMode: 'live_command', ruleVersion: 2 });
    });

    it('flag off keeps the legacy path without pinned loading or audit marker', async () => {
      vi.stubEnv('BACKEND_MDF_PINNED_DISPATCH', 'false'); mocks.current.mockResolvedValue([rule()]);
      await dispatchMdfBoardEvent(tx(), liveInput());
      expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.details).toHaveBeenCalledOnce();
      expect(mocks.audit.mock.calls.at(-1)?.[1].metadata.executionMode).toBeUndefined();
    });

    it('disabled automation still observes shadows but does not resolve or write', async () => {
      vi.stubEnv('BACKEND_STATUS_AUTOMATION', 'false');
      await dispatchMdfBoardEvent(tx(), liveInput());
      expect(mocks.shadow).toHaveBeenCalledOnce(); expect(mocks.all).not.toHaveBeenCalled();
      expect(mocks.resolve).not.toHaveBeenCalled(); expect(mocks.details).not.toHaveBeenCalled();
    });

    it.each(['missing', 'disabled', 'version_changed'] as const)('skips %s pin without legacy fallback', async reason => {
      mocks.load.mockResolvedValue(reason === 'missing' ? [] : [rule(reason === 'disabled' ? { isEnabled: false } : { version: 3 })]);
      await dispatchMdfBoardEvent(tx(), liveInput());
      expect(mocks.details).not.toHaveBeenCalled(); expect(mocks.current).not.toHaveBeenCalled();
      expect(mocks.audit.mock.calls[0][1].metadata).toMatchObject({ executionMode: 'live_command', reason: `pinned_rule_${reason}` });
    });

    it('freezes rules across multiple sources, preserving visited guard, then refreshes only on a new transaction', async () => {
      const transaction = tx(), command = liveInput();
      await dispatchMdfBoardEvent(transaction, command);
      mocks.all.mockResolvedValue([rule({ id: 99, priority: 0 })]);
      await dispatchMdfBoardEvent(transaction, command);
      expect(mocks.details).toHaveBeenCalledOnce(); // same source already executed
      const other = input().events; other[0].scope.source = { kind: 'bazisCutSet', id: '42' };
      mocks.resolve.mockResolvedValue(other);
      await dispatchMdfBoardEvent(transaction, { ...command, source: other[0].scope.source });
      expect(mocks.details).toHaveBeenCalledTimes(2); // different source, original rule
      expect(mocks.all).toHaveBeenCalledOnce();
      expect(mocks.load.mock.calls.map(call => call[1])).toEqual([[17], [17], [17]]);
      mocks.load.mockResolvedValue([rule({ id: 99, priority: 0 })]);
      await dispatchMdfBoardEvent(tx(), { ...command, source: other[0].scope.source });
      expect(mocks.all).toHaveBeenCalledTimes(2); expect(mocks.load.mock.calls.at(-1)?.[1]).toEqual([99]);
    });

    it('freezes an empty selection so newly enabled rules wait for next transaction', async () => {
      const transaction = tx(); mocks.all.mockResolvedValueOnce([]);
      await dispatchMdfBoardEvent(transaction, liveInput());
      await dispatchMdfBoardEvent(transaction, liveInput());
      expect(mocks.all).toHaveBeenCalledOnce(); expect(mocks.resolve).not.toHaveBeenCalled();
      await dispatchMdfBoardEvent(tx(), liveInput());
      expect(mocks.details).toHaveBeenCalledOnce();
    });

    it('preserves an existing downstream visited guard and pins nested composition', async () => {
      const transaction = tx(), command = liveInput();
      const downstream = rule({ id: 18, eventType: 'order.production_status_changed', actionType: 'change_order_status' });
      mocks.current.mockResolvedValue([downstream]);
      await evaluateProductionCompositionAutomation(transaction, { ...command, orderId: 1 });
      mocks.all.mockResolvedValue([rule(), downstream]); mocks.load.mockResolvedValue([rule(), downstream]);
      mocks.details.mockImplementation(async () => {
        await evaluateProductionCompositionAutomation(transaction, { ...command, orderId: 1 });
        return { status: 'executed' };
      });
      await dispatchMdfBoardEvent(transaction, command);
      expect(mocks.order).toHaveBeenCalledOnce(); expect(mocks.current).toHaveBeenCalledOnce();
      expect(mocks.load).toHaveBeenCalledWith(transaction, [17, 18]);
    });

    it('resolves impacted baths before any action, never substitutes caller events', async () => {
      const bath = structuredClone(input().events[0]);
      bath.scope.source = { kind: 'bath', id: 'cut-result:42' }; bath.eventType = 'mdf.board.baths_ready';
      const bathRule = rule({ id: 18, eventType: bath.eventType });
      mocks.all.mockResolvedValue([rule(), bathRule]); mocks.load.mockResolvedValue([rule(), bathRule]);
      mocks.resolve.mockResolvedValueOnce([...input().events, bath]).mockResolvedValueOnce([bath]);
      mocks.details.mockImplementation(async () => {
        expect(mocks.resolve).toHaveBeenCalledTimes(2); return { status: 'executed' };
      });
      const command = { ...liveInput(), events: [] };
      await dispatchMdfBoardEvent(tx(), command);
      expect(mocks.details).toHaveBeenCalledTimes(2);
      expect(mocks.details.mock.calls[1][3].mdfBoardScope.source).toEqual(bath.scope.source);
    });

    it('malformed server scope fails closed before action or fallback', async () => {
      const batch = input(); batch.events[0].scope.details[0].eligibleQuantity = -1;
      mocks.resolve.mockResolvedValue(batch.events);
      await expect(dispatchMdfBoardEvent(tx(), liveInput())).rejects.toThrow('MDF_INVALID_PINNED_BATCH');
      expect(mocks.load).not.toHaveBeenCalled(); expect(mocks.details).not.toHaveBeenCalled();
      expect(mocks.current).not.toHaveBeenCalled();
    });
  });
});
