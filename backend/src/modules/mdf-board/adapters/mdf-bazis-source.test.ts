import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
const mocks = vi.hoisted(() => ({ boundary: vi.fn(), receipt: vi.fn(), demand: vi.fn() }));
vi.mock('../application/mdf-command-boundary', () => ({ requireMdfCommandBoundary: mocks.boundary }));
vi.mock('../application/mdf-receipt', () => ({ recordMdfReceipt: mocks.receipt }));
vi.mock('./mdf-execution-snapshot', () => ({ loadMdfExecutionDetails: mocks.demand }));
import { captureNewMdfBazisSource, registerNewMdfBazisSource } from './mdf-bazis-source';

const user: CurrentUser = { id: '1',username: 'E2E source',role: 'admin',roleId: 1,permissions: ['cut.manage','orders.view'] };
describe('new BASIS source capture', () => {
  const rows = () => [{ lineKey: '5',orderId: 1,detailId: 11,quantity: 4 }];
  let members = rows();
  let existing = false;
  function fixture(register = true) {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM mdf_source_heads') ? existing ? [{}] : []
      : sql.includes('FROM bazis_cut_set_details') ? members : sql.includes('FROM status_automation_rules') ? [{ ruleId: 17,version: 1 }]
      : sql.includes('FROM bazis_cut_sets') ? [{ name: 'E2E set',createdAt: '2026-09-21T00:00:00Z' }] : [] }));
    const tx = { query,raw: {} } as unknown as TransactionClient;
    if (register) registerNewMdfBazisSource(tx,7);
    const run = () => captureNewMdfBazisSource(tx,{ setId: 7,lockedOrderIds: [1],user,requestId: 'E2E request' });
    return { tx,run,query };
  }
  beforeEach(() => {
    vi.resetAllMocks(); members = rows(); existing = false;
    mocks.boundary.mockResolvedValue({ mode: 'active',queued: true });
    mocks.receipt.mockResolvedValue({ jobId: 'E2E job',replay: false,accepted: true });
    mocks.demand.mockResolvedValue([{ orderId: 1,detailId: 11,quantity: 4,rank: 50 },
      { orderId: 1,detailId: 12,quantity: 2,rank: null }]);
  });
  afterEach(() => vi.restoreAllMocks());
  it('freezes whole-owner demand but emits only own membership, never cut proof from detail status', async () => {
    const f = fixture(); expect(await f.run()).toBe('E2E job');
    expect(mocks.receipt).toHaveBeenCalledExactlyOnceWith(f.tx,expect.objectContaining({ sourceKind: 'bazisCutSet',
      sourceId: '7',origin: 'derived',accept: true,expectedFence: null,actorUserId: 1,requestId: 'E2E request',
      lines: [{ lineKey: '5',orderId: 1,detailId: 11,quantity: 4,stageCode: 'membership',evidenceKind: 'derived',rework: false }],
      executionContext: { sourceCreatedAt: '2026-09-21T00:00:00Z',displayName: 'E2E set',priorColumn: 'parsed',
        manualPlacementColumn: null,compositionComplete: true,demand: [{ orderId: 1,detailId: 11,quantity: 4 },
          { orderId: 1,detailId: 12,quantity: 2 }] },rules: [{ ruleId: 17,version: 1 }] }));
  });
  it('requires a source created in this exact transaction, not a historical set without a head', async () => {
    const f = fixture(false);
    await expect(f.run()).rejects.toMatchObject({ code: 'MDF_NEW_SOURCE_REQUIRED' });
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it('cannot replace an existing source head', async () => {
    existing = true; await expect(fixture().run()).rejects.toMatchObject({ code: 'MDF_NEW_SOURCE_REQUIRED' });
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it('consumes fresh-source registration once and cannot transfer it to another transaction', async () => {
    const first = fixture(); await first.run();
    await expect(first.run()).rejects.toMatchObject({ code: 'MDF_NEW_SOURCE_REQUIRED' });
    await expect(fixture(false).run()).rejects.toMatchObject({ code: 'MDF_NEW_SOURCE_REQUIRED' });
    expect(mocks.receipt).toHaveBeenCalledOnce();
  });
  it('does nothing for HDF/non-MDF-only sets, keeping the material and source-type filter in SQL', async () => {
    members = []; const f = fixture(); expect(await f.run()).toBeUndefined();
    expect(mocks.receipt).not.toHaveBeenCalled(); expect(mocks.demand).not.toHaveBeenCalled();
    const sql = f.query.mock.calls.map(c => c[0]).find(s => s.includes('FROM bazis_cut_set_details'))!;
    expect(sql).toContain('source_order_hdf_detail_id IS NULL');
    expect(sql).toContain('cut_enabled'); expect(sql).toContain('material_name'); expect(sql).toContain('!~*');
  });
  it.each(['missing','wrong-owner','quantity','duplicate'] as const)('rejects %s membership before receipt', async issue => {
    if (issue === 'missing') members[0].detailId = 99;
    if (issue === 'wrong-owner') members[0].orderId = 2;
    if (issue === 'quantity') members[0].quantity = 0;
    if (issue === 'duplicate') members.push({ ...members[0] });
    await expect(fixture().run()).rejects.toMatchObject({ code: 'MDF_NEW_SOURCE_INVALID' });
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
  it('cannot capture outside active mode', async () => {
    mocks.boundary.mockResolvedValue({ mode: 'legacy',queued: false });
    await expect(fixture().run()).rejects.toThrow('MDF_ACTIVE_COMMAND_REQUIRED');
    expect(mocks.receipt).not.toHaveBeenCalled();
  });
});
