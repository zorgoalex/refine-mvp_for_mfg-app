import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { StatusAutomationRule } from './status-automation.types';
import { snapshotPinnedMdfBatch } from './mdf-pinned-batch';
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
import { executePinnedMdfAutomation } from './status-automation-runtime';

const detailRule: StatusAutomationRule = { id:17,version:1,name:'pinned direct detail',eventType:'mdf.board.completed',
  actionType:'change_details_production_status',targetStatusId:2,priority:10,isEnabled:true,conditions:{},
  actionConfig:{detailTransitionMode:'set_exact'} };
const compositionRule: StatusAutomationRule = { id:18,version:4,name:'pinned composition',
  eventType:'order.production_status_changed',actionType:'change_order_status',targetStatusId:3,priority:10,
  isEnabled:true,conditions:{},actionConfig:{} };
const input = () => ({ actor:{id:'1',username:'pinned-test',role:'admin',roleId:1,permissions:[]},
  requestId:'pinned-test-request',sourceIdempotencyKey:'cnc-job-1',pins:[{ruleId:17,version:1}],
  events:[{eventType:'mdf.board.completed' as const,orderId:8,scope:{source:{kind:'packet' as const,
    id:'11111111-1111-1111-1111-111111111111'},details:[{detailId:81,requiredQuantity:10,eligibleQuantity:10}]}}] });
const tx = () => ({query:vi.fn(),raw:{}}) as unknown as TransactionClient;

describe('pinned CNC composition follow-up batch boundary', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('snapshots, deduplicates only by rejection, and sorts changed composition owner IDs', () => {
    const batch = {...input(),productionCompositionOrderIds:[12,8,4]};
    const snapshot = snapshotPinnedMdfBatch(batch,false,true);
    expect(snapshot.productionCompositionOrderIds).toEqual([4,8,12]);
    batch.productionCompositionOrderIds.splice(0);
    expect(snapshot.productionCompositionOrderIds).toEqual([4,8,12]);
  });

  it('rejects changed-owner IDs at live-command/default boundaries', () => {
    const batch = {...input(),productionCompositionOrderIds:[8]};
    expect(() => snapshotPinnedMdfBatch(batch)).toThrow('MDF_INVALID_PINNED_BATCH');
    expect(() => snapshotPinnedMdfBatch(batch,true,false)).toThrow('MDF_INVALID_PINNED_BATCH');
    expect(() => snapshotPinnedMdfBatch({...batch,productionCompositionOrderIds:Array.from({length:101},(_,i)=>i+1)},
      false,true)).toThrow('MDF_INVALID_PINNED_BATCH');
  });

  it.each([
    ['duplicate', [8,8]],
    ['zero', [0]],
    ['negative', [-1]],
    ['fraction', [8.5]],
    ['unsafe integer', [Number.MAX_SAFE_INTEGER + 1]],
    ['too many', Array.from({length:101},(_,index)=>index+1)],
  ] as const)('rejects invalid changed-owner IDs (%s) before execution', async (_label, ids) => {
    const transaction = tx();
    mocks.load.mockClear(); mocks.details.mockClear(); mocks.order.mockClear();
    expect(() => snapshotPinnedMdfBatch({...input(),productionCompositionOrderIds:ids},false,true)).toThrow('MDF_INVALID_PINNED_BATCH');
    await expect(executePinnedMdfAutomation(transaction,{...input(),productionCompositionOrderIds:ids})).rejects
      .toThrow('MDF_INVALID_PINNED_BATCH');
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.details).not.toHaveBeenCalled();
    expect(mocks.order).not.toHaveBeenCalled();
  });

  it('runs downstream changed-owner events through exactly the same durable pins', async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    mocks.load.mockReset().mockResolvedValue([detailRule,compositionRule]);
    mocks.current.mockReset().mockResolvedValue([compositionRule]);
    mocks.state.mockReset().mockImplementation(async (_transaction:TransactionClient,orderId:number) => ({
      orderId,orderStatusId:1,productionStatusId:2,productionSummary:{detailCount:1,unassignedCount:0,statusIds:[2]},
      paymentStatusId:1,finalAmount:100,paidAmount:100,source:'manual',
    }));
    mocks.details.mockReset().mockResolvedValue({status:'executed'});
    mocks.order.mockReset().mockResolvedValue({status:'executed'});
    mocks.audit.mockReset().mockResolvedValue('audit');
    const transaction = tx();
    const batch = {...input(),pins:[{ruleId:17,version:1},{ruleId:18,version:4}],productionCompositionOrderIds:[12,8]};
    const result = await executePinnedMdfAutomation(transaction,batch);
    expect(result).toMatchObject({status:'evaluated',selectedRuleCount:2});
    expect(mocks.load).toHaveBeenCalledExactlyOnceWith(transaction,[17,18]);
    expect(mocks.details).toHaveBeenCalledOnce();
    expect(mocks.order.mock.calls.map(call=>call[1])).toEqual([8,12]);
    expect(mocks.current).not.toHaveBeenCalled();
    expect(mocks.all).not.toHaveBeenCalled();
  });

  it('does not fall back to unpinned current order rules for changed owners', async () => {
    vi.stubEnv('BACKEND_STATUS_AUTOMATION','true');
    mocks.load.mockReset().mockResolvedValue([detailRule,compositionRule]);
    mocks.current.mockReset().mockResolvedValue([compositionRule]);
    mocks.state.mockReset().mockImplementation(async (_transaction:TransactionClient,orderId:number) => ({
      orderId,orderStatusId:1,productionStatusId:2,productionSummary:{detailCount:1,unassignedCount:0,statusIds:[2]},
      paymentStatusId:1,finalAmount:100,paidAmount:100,source:'manual',
    }));
    mocks.details.mockReset().mockResolvedValue({status:'executed'});
    mocks.order.mockReset().mockResolvedValue({status:'executed'});
    mocks.audit.mockReset().mockResolvedValue('audit');
    await executePinnedMdfAutomation(tx(),{...input(),productionCompositionOrderIds:[8]});
    expect(mocks.details).toHaveBeenCalledOnce();
    expect(mocks.order).not.toHaveBeenCalled();
    expect(mocks.current).not.toHaveBeenCalled();
  });
});
