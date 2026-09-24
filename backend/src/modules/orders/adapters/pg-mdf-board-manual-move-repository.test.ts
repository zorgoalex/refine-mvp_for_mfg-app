import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { PgMdfBoardManualMoveRepository } from './pg-mdf-board-manual-move-repository';

const runtimeMocks = vi.hoisted(() => ({
  evaluateMdfBoardColumnAutomation: vi.fn(async () => undefined),
  snapshot: vi.fn(async () => ({cards:[{kind:'packet',id:'packet-1',column:'parsed'}]})),
  observe: vi.fn(async () => undefined),
}));
vi.mock('../../mdf-board/application/mdf-shadow', () => ({ observeMdfShadowCommand: runtimeMocks.observe }));
vi.mock('../../mdf-board/application/mdf-command-boundary', () => ({
  requireMdfCommandBoundary: vi.fn(async () => ({ mode: 'legacy',queued: false })),
}));
vi.mock('./mdf-return-snapshot', () => ({
  returnSourceOwners: vi.fn(async () => [1001]),
  loadReturnSnapshot: runtimeMocks.snapshot,
}));

vi.mock('../../status-automation/application/status-automation-runtime', () => ({
  dispatchMdfBoardEvent: runtimeMocks.evaluateMdfBoardColumnAutomation,
}));

describe('PgMdfBoardManualMoveRepository', () => {
  beforeEach(() => {
    runtimeMocks.evaluateMdfBoardColumnAutomation.mockClear();
    runtimeMocks.observe.mockClear();
    runtimeMocks.snapshot.mockResolvedValue({cards:[{kind:'packet',id:'packet-1',column:'parsed'}]});
  });

  it('creates a shared move, writes audit, and emits MDF board automation per related order', async () => {
    const tx = fakeTx([
      rows(),
      rows(),
      rows([row({ target_column: 'completed' })]),
      rows([{ order_id: 1001 }, { order_id: 1002 }]),
      rows([{ audit_id: 'audit-1' }]),
    ]);
    const repo = new PgMdfBoardManualMoveRepository(fakeDatabase(tx));

    const result = await repo.upsert({
      currentUser: user(),
      cardKind: 'packet',
      cardId: 'packet-1',
      targetColumn: 'completed',
      requestId: 'req-1',
    });

    expect(result).toMatchObject({ changed: true, auditId: 'audit-1', move: { targetColumn: 'completed' } });
    expect(tx.texts.some((text) => text.includes('INSERT INTO mdf_board_manual_moves'))).toBe(true);
    expect(tx.texts.some((text) => text.includes('INSERT INTO audit_log'))).toBe(true);
    expect(runtimeMocks.observe).toHaveBeenCalledWith(tx, expect.objectContaining({
      source: { kind: 'packet', id: 'packet-1' }, actor: user(), requestId: 'req-1',
    }), { kind: 'manual_move', targetColumn: 'completed', auditId: 'audit-1' });
    expect(runtimeMocks.observe.mock.invocationCallOrder[0]).toBeLessThan(runtimeMocks.evaluateMdfBoardColumnAutomation.mock.invocationCallOrder[0]);
    expect(runtimeMocks.evaluateMdfBoardColumnAutomation).toHaveBeenCalledWith(expect.anything(), {
      source: { kind: 'packet', id: 'packet-1' },
      actor: user(),
      requestId: 'req-1',
      sourceIdempotencyKey: 'mdf-board:manual:packet:packet-1:version-1:completed:audit-audit-1',
    });
  });

  it('recreated version-one move has a new cause instead of replaying its deleted predecessor', async () => {
    const causes: string[] = [];
    for (const auditId of ['first-command', 'recreated-command']) {
      const tx = fakeTx([rows(), rows(), rows([row()]), rows(), rows([{ audit_id: auditId }])]);
      await new PgMdfBoardManualMoveRepository(fakeDatabase(tx)).upsert({
        currentUser: user(), cardKind: 'packet', cardId: 'packet-1', targetColumn: 'completed', requestId: auditId,
      });
      const call = runtimeMocks.evaluateMdfBoardColumnAutomation.mock.calls.at(-1) as unknown as [unknown, { sourceIdempotencyKey: string }];
      causes.push(call[1].sourceIdempotencyKey);
    }
    expect(causes[0]).not.toBe(causes[1]);
    expect(causes.every(cause => cause.includes('version-1:completed:'))).toBe(true);
  });

  it('treats same-target PUT as no-op without duplicate audit', async () => {
    const tx = fakeTx([
      rows(),
      rows([row({ target_column: 'completed' })]),
    ]);
    const repo = new PgMdfBoardManualMoveRepository(fakeDatabase(tx));

    const result = await repo.upsert({
      currentUser: user(),
      cardKind: 'packet',
      cardId: 'packet-1',
      targetColumn: 'completed',
      requestId: 'req-1',
    });

    expect(result).toMatchObject({ changed: false, move: { targetColumn: 'completed' } });
    expect(tx.texts.some((text) => text.includes('INSERT INTO audit_log'))).toBe(false);
    expect(runtimeMocks.observe).not.toHaveBeenCalled();
  });

  it('treats missing DELETE as no-op without audit', async () => {
    const tx = fakeTx([
      rows(),
      rows(),
    ]);
    const repo = new PgMdfBoardManualMoveRepository(fakeDatabase(tx));

    const result = await repo.delete({
      currentUser: user(),
      cardKind: 'packet',
      cardId: 'packet-1',
      requestId: 'req-1',
    });

    expect(result).toMatchObject({ deleted: false });
    expect(tx.texts.some((text) => text.includes('DELETE FROM mdf_board_manual_moves'))).toBe(false);
    expect(tx.texts.some((text) => text.includes('INSERT INTO audit_log'))).toBe(false);
    expect(runtimeMocks.observe).not.toHaveBeenCalled();
  });

  it('observes deletion as visual clear before dispatch, not production return', async () => {
    const tx = fakeTx([rows(), rows([row()]), rows(), rows([{ audit_id: 'audit-clear' }])]);
    await new PgMdfBoardManualMoveRepository(fakeDatabase(tx)).delete({
      currentUser: user(), cardKind: 'packet', cardId: 'packet-1', requestId: 'clear',
    });
    expect(runtimeMocks.observe).toHaveBeenCalledWith(tx, expect.objectContaining({ requestId: 'clear' }),
      { kind: 'manual_clear', targetColumn: null, auditId: 'audit-clear' });
    expect(runtimeMocks.observe.mock.invocationCallOrder[0]).toBeLessThan(runtimeMocks.evaluateMdfBoardColumnAutomation.mock.invocationCallOrder[0]);
  });

  it('rejects legacy PUT that would cosmetically reopen a completed source', async () => {
    runtimeMocks.snapshot.mockResolvedValue({cards:[{kind:'packet',id:'packet-1',column:'completed_laminated'}]});
    const tx=fakeTx([rows()]);
    await expect(new PgMdfBoardManualMoveRepository(fakeDatabase(tx)).upsert({
      currentUser:user(),cardKind:'packet',cardId:'packet-1',targetColumn:'parsed',requestId:'return',
    })).rejects.toMatchObject({code:'MDF_RETURN_CONFIRMATION_REQUIRED'});
    expect(tx.texts.some(text=>text.includes('INSERT'))).toBe(false);
  });
});

function fakeDatabase(tx: TransactionClient) {
  return {
    transaction: (handler: (client: TransactionClient) => Promise<unknown>) => handler(tx),
    query: async () => rows(),
  } as unknown as ConstructorParameters<typeof PgMdfBoardManualMoveRepository>[0];
}

function fakeTx(queue: QueryResult<QueryResultRow>[]): TransactionClient & { texts: string[] } {
  const texts: string[] = [];
  return {
    raw: {} as TransactionClient['raw'],
    texts,
    async query<T extends QueryResultRow = QueryResultRow>(text: string): Promise<QueryResult<T>> {
      texts.push(text);
      if (text==='SET LOCAL jit=off') return rows() as QueryResult<T>;
      return (queue.shift() ?? rows()) as QueryResult<T>;
    },
  };
}

function rows<T extends QueryResultRow = QueryResultRow>(input: T[] = []): QueryResult<T> {
  return {
    command: 'SELECT',
    rowCount: input.length,
    oid: 0,
    fields: [],
    rows: input,
  };
}

function row(patch: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    card_kind: 'packet',
    card_id: 'packet-1',
    target_column: 'completed',
    version: 1,
    created_at: '2026-08-11T00:00:00.000Z',
    created_by_user_id: 7,
    updated_at: '2026-08-11T00:00:00.000Z',
    updated_by_user_id: 7,
    ...patch,
  };
}

function user() {
  return {
    id: '7',
    username: 'manager',
    role: 'manager' as const,
    roleId: 10,
    permissions: ['production.tasks.update'] as const,
  };
}
