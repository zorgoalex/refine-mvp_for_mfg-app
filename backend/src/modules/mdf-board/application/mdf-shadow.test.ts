import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import { beginTransactionHooks, flushTransactionHooks, discardTransactionHooks } from '../../../database/transaction-hooks';
import { prepareMdfShadow, markMdfShadowSource } from './mdf-shadow';
import type { MdfShadowRow } from '../adapters/mdf-shadow-source';
import type { MdfBoardEventInput } from '../../status-automation/application/mdf-board-event.types';

const row = (patch: Partial<MdfShadowRow> = {}): MdfShadowRow => ({ line_key: 'a', order_id: '1', detail_id: '11',
  quantity: '5', relevant: true, cut: true, laminated: false, rework: false,
  unresolved: false, whole_order: false, stamp: 'v1', ...patch });
const input: MdfBoardEventInput = { source: { kind: 'packet', id: '12345678-1234-1234-1234-123456789012' },
  actor: { id: '1', username: 'test', role: 'admin', roleId: 1, permissions: [] },
  requestId: 'request', sourceIdempotencyKey: 'command' };
afterEach(() => vi.unstubAllEnvs());

describe('MDF shadow candidate', () => {
  it('freezes only own membership and physical signals', () => {
    const result = prepareMdfShadow([row(), row({ line_key: 'b', detail_id: '12', cut: false, quantity: '3' })]);
    expect(result.candidateQuantities).toMatchObject({ required: 8, cut: 5, remaining: 3, complete: false });
    expect(result.lines).toHaveLength(3);
    expect(result.issues).toContain('SHADOW_ONLY');
  });
  it('does not cover another position with excess or rework', () => {
    const result = prepareMdfShadow([row({ quantity: '10', rework: true }),
      row({ line_key: 'b', detail_id: '12', cut: false, quantity: '2' })]);
    expect(result.candidateQuantities).toMatchObject({ cut: 10, creditedCut: 0, remaining: 12, complete: false });
  });
  it('rejects unknown membership and excluded material, never invents whole-order quantity', () => {
    const result = prepareMdfShadow([row({ unresolved: true }), row({ line_key: 'b', relevant: false }),
      row({ line_key: null, detail_id: null, whole_order: true })]);
    expect(result.lines).toEqual([]);
    expect(result.candidateQuantities.required).toBe(0);
    expect(result.issues).toEqual(expect.arrayContaining(['UNRESOLVED_MEMBERSHIP', 'MATERIAL_OR_SOURCE_EXCLUDED',
      'WHOLE_ORDER_DECLARATION_NOT_FROZEN']));
  });
  it('manual bath-ready without laminate is membership, not physical supply', () => {
    const result = prepareMdfShadow([row({ cut: false })]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].evidenceKind).toBe('derived');
    expect(result.candidateQuantities).toMatchObject({ cut: 0, rolled: 0, complete: false });
  });
  it('laminating B does not reduce the cut count of A', () => {
    const result = prepareMdfShadow([row(), row({ line_key: 'b', detail_id: '12', cut: false, laminated: true })]);
    expect(result.candidateQuantities).toMatchObject({ cut: 5, rolled: 5 });
  });
  it('records absent source as a blocker', () => expect(prepareMdfShadow([]).issues).toContain('SOURCE_MISSING'));
});
describe('shadow registration', () => {
  it('is zero work while disabled, even without a transaction hook owner', () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'false');
    const query = vi.fn();
    markMdfShadowSource({ query } as unknown as TransactionClient, input);
    expect(query).not.toHaveBeenCalled();
  });
  it('does not take SQL locks until transaction finalization, rejects incompatible mode', async () => {
    vi.stubEnv('BACKEND_MDF_SHADOW_INTAKE', 'true');
    const query = vi.fn().mockResolvedValue({ rows: [{ mode: 'active' }] });
    const tx = { query } as unknown as TransactionClient;
    beginTransactionHooks(tx);
    markMdfShadowSource(tx, input); markMdfShadowSource(tx, input);
    expect(query).not.toHaveBeenCalled();
    await expect(flushTransactionHooks(tx)).rejects.toThrow('MDF_SHADOW_MODE_CONFLICT');
    expect(query).toHaveBeenCalledTimes(2);
    discardTransactionHooks(tx);
  });
});
