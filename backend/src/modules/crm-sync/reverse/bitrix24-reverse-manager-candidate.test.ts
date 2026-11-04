import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import { ORDER_MANAGER_CANDIDATE_SQL } from '../../orders/domain/order-manager-assignment';
import { resolveMappedManagerId } from './pg-bitrix24-reverse-repository';

function fakeTx(rows: QueryResultRow[], captured: Array<{ text: string; params: readonly unknown[] }>): TransactionClient {
  return {
    raw: undefined as never,
    async query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      captured.push({ text, params: [...params] });
      return { rows: rows as T[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  };
}

describe('Bitrix24 responsible → ERP order manager', () => {
  it('uses the shared order-manager rule: a mapped account that cannot see orders is no manager', async () => {
    const captured: Array<{ text: string; params: readonly unknown[] }> = [];
    expect(await resolveMappedManagerId(fakeTx([], captured), '18')).toBeNull();
    expect(captured[0].text).toContain(ORDER_MANAGER_CANDIDATE_SQL);
    expect(captured[0].text).toContain('JOIN users u ON u.user_id=mapping.erp_user_id');
    expect(captured[0].params).toEqual(['18']);
  });

  it('returns the eligible mapped user and asks nothing without a Bitrix responsible', async () => {
    const captured: Array<{ text: string; params: readonly unknown[] }> = [];
    expect(await resolveMappedManagerId(fakeTx([{ erp_user_id: '91' }], captured), '18')).toBe(91);
    expect(await resolveMappedManagerId(fakeTx([], captured), null)).toBeNull();
    expect(captured).toHaveLength(1);
  });
});
