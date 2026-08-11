import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { DatabaseClient, TransactionClient } from '../../../database/database.types';
import { PgMdfBoardManualMoveRepository } from './pg-mdf-board-manual-move-repository';

const runtimeMocks = vi.hoisted(() => ({
  evaluateMdfBoardColumnAutomation: vi.fn(async () => undefined),
}));

vi.mock('../../status-automation/application/status-automation-runtime', () => ({
  evaluateMdfBoardColumnAutomation: runtimeMocks.evaluateMdfBoardColumnAutomation,
}));

describe('PgMdfBoardManualMoveRepository', () => {
  beforeEach(() => {
    runtimeMocks.evaluateMdfBoardColumnAutomation.mockClear();
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
    expect(runtimeMocks.evaluateMdfBoardColumnAutomation).toHaveBeenCalledWith(expect.anything(), {
      eventType: 'mdf.board.completed',
      orderIds: [1001, 1002],
      actor: user(),
      requestId: 'req-1',
      sourceIdempotencyKey: 'mdf-board:manual:packet:packet-1:version-1:completed',
    });
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
