import { describe, expect, it, vi, afterEach } from 'vitest';
import type { MdfShadowRow } from '../adapters/mdf-shadow-source';
import type { MdfBoardEventInput } from '../../status-automation/application/mdf-board-event.types';
import type { TransactionClient } from '../../../database/database.types';
import { prepareMdfShadowCommand, observeMdfShadowCommand } from './mdf-shadow';

const input: MdfBoardEventInput = { source: { kind: 'packet', id: '00000000-0000-0000-0000-000000000001' },
  actor: { id: '1', username: 'E2E', role: 'admin', roleId: 1, permissions: [] },
  requestId: 'request', sourceIdempotencyKey: 'cause' };
const command = { kind: 'manual_move' as const, targetColumn: 'completed', auditId: '00000000-0000-0000-0000-000000000002' };
const row = (patch: Partial<MdfShadowRow> = {}): MdfShadowRow => ({ line_key: 'a', order_id: '1', detail_id: '11',
  quantity: '5', relevant: true, cut: true, laminated: true, rework: false, unresolved: false,
  whole_order: false, stamp: 'v1', ...patch });
afterEach(() => vi.unstubAllEnvs());

describe('explicit MDF shadow command provenance', () => {
  it('freezes own membership without turning manual or raw completion into physical supply', () => {
    const prepared = prepareMdfShadowCommand(input, command, [row(), row({ line_key: 'b', detail_id: '12', relevant: false })]);
    expect(prepared.lines).toHaveLength(1);
    expect(prepared.lines[0]).toMatchObject({ detailId: 11, quantity: 5, stageCode: 'membership', evidenceKind: 'derived' });
    expect(prepared.candidateQuantities).toMatchObject({ required: 5, cut: 0, rolled: 0, remaining: 5 });
    expect(prepared.issues).toContain('EXPLICIT_COMMAND_UNVERIFIED');
  });
  it('composition digest ignores status/timestamp/row order but detects quantities and membership', () => {
    const rows = [row(), row({ line_key: 'b', detail_id: '12' })];
    const first = prepareMdfShadowCommand(input, command, rows);
    const second = prepareMdfShadowCommand(input, command, [...rows].reverse().map(r => ({ ...r, stamp: 'v2', cut: false, laminated: false })));
    expect(second.compositionDigest).toBe(first.compositionDigest);
    expect(second.receiptDigest).not.toBe(first.receiptDigest);
    for (const patch of [{ quantity: '6' }, { detail_id: '13' }, { relevant: false }, { rework: true }, { whole_order: true }]) {
      expect(prepareMdfShadowCommand(input, command, [row(patch), rows[1]]).compositionDigest).not.toBe(first.compositionDigest);
    }
  });
  it('binds audit, target, actor, request, cause, and explicit return stage in receipt digest', () => {
    const first = prepareMdfShadowCommand(input, command, [row()]).receiptDigest;
    for (const changed of [{ ...command, targetColumn: 'completed_laminated' },
      { ...command, auditId: '00000000-0000-0000-0000-000000000003' }]) {
      expect(prepareMdfShadowCommand(input, changed, [row()]).receiptDigest).not.toBe(first);
    }
    for (const changed of [{ ...input, requestId: 'new' }, { ...input, sourceIdempotencyKey: 'new' },
      { ...input, actor: { ...input.actor, id: '2' } }]) {
      expect(prepareMdfShadowCommand(changed, command, [row()]).receiptDigest).not.toBe(first);
    }
    const returned = { kind: 'production_return' as const, auditId: command.auditId, targetColumn: 'completed',
      targetStageId: 4, targetStageCode: 'sanded', previewDigest: 'a'.repeat(64) };
    const original = prepareMdfShadowCommand(input, returned, [row()]).receiptDigest;
    for (const patch of [{ targetStageId: 5 }, { targetStageCode: 'custom' }, { previewDigest: 'b'.repeat(64) }]) {
      expect(prepareMdfShadowCommand(input, { ...returned, ...patch }, [row()]).receiptDigest).not.toBe(original);
    }
  });
  it('rejects mismatched columns, malformed audit and incomplete return metadata', () => {
    expect(() => prepareMdfShadowCommand(input, { ...command, targetColumn: 'baths_ready' }, [])).toThrow('MDF_SHADOW_COMMAND_INVALID');
    expect(() => prepareMdfShadowCommand(input, { ...command, auditId: '' }, [])).toThrow('MDF_SHADOW_COMMAND_INVALID');
    expect(() => prepareMdfShadowCommand(input, { ...command, kind: 'production_return' } as never, [])).toThrow('MDF_SHADOW_COMMAND_INVALID');
  });
  it('clear is visual-only; ready bath never creates anonymous supply', () => {
    const clear = prepareMdfShadowCommand(input, { kind: 'manual_clear', targetColumn: null, auditId: command.auditId }, [row()]);
    const ready = prepareMdfShadowCommand({ ...input, source: { kind: 'bath', id: 'cut-result:1' } },
      { ...command, targetColumn: 'baths_ready' }, [row()]);
    expect(clear.candidateQuantities.cut).toBe(0);
    expect(ready.candidateQuantities.cut).toBe(0);
  });
  it('disabled intake does no reads or hook registration', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'false');
    const query = vi.fn();
    await observeMdfShadowCommand({ query } as unknown as TransactionClient, input, command);
    expect(query).not.toHaveBeenCalled();
  });
});
