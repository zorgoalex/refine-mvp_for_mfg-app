import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../../common/audit/audit.service';
import type { DatabaseService } from '../../../database/database.service';
import { PgBitrix24ReverseRepository } from './pg-bitrix24-reverse-repository';

/**
 * retryFailedEvents against a scripted transaction: the open-object unique index
 * (uq_bitrix24_inbound_event_open_object) is simulated by a 23505 on one requeue, as when a webhook
 * opens an event for that object between the candidate read and the update.
 */
function harness(conflictIds: string[]) {
  const statements: string[] = [];
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
      if (/WHERE status='failed'/.test(sql)) return { rows: [], rowCount: 2 };
      if (/SELECT DISTINCT ON/.test(sql)) {
        return { rows: [{ inbound_event_id: 'a' }, { inbound_event_id: 'b' }, { inbound_event_id: 'c' }], rowCount: 3 };
      }
      if (/WHERE inbound_event_id=\$1 AND status='dead'/.test(sql)) {
        if (conflictIds.includes(String(params[0]))) {
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
        }
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO bitrix24_inbound_event/.test(sql)) {
        expect(sql).toContain('ON CONFLICT DO NOTHING');
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const db = { transaction: vi.fn(async (handler: (t: typeof tx) => Promise<unknown>) => handler(tx)) };
  const audit = { record: vi.fn(async () => undefined) };
  const repo = new PgBitrix24ReverseRepository(db as unknown as DatabaseService, audit as unknown as AuditService);
  return { repo, audit, statements };
}

describe('PgBitrix24ReverseRepository.retryFailedEvents', () => {
  it('requeues failed events and the newest dead event of each object', async () => {
    const { repo, audit, statements } = harness([]);
    await expect(repo.retryFailedEvents({ actorUserId: '1', auditRequestId: 'r' })).resolves.toBe(5);
    expect(statements.filter((s) => s.startsWith('SAVEPOINT'))).toHaveLength(3);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'bitrix24_reverse.retry_failed',
      after: { retried: 5, failedEventsRetried: 5, deadSkippedOpenEvent: 0, blockedRequestsEnqueued: 0 },
    }));
  });

  it('skips a dead event whose object got an open event concurrently instead of failing the command', async () => {
    const { repo, audit, statements } = harness(['b']);
    await expect(repo.retryFailedEvents({ actorUserId: '1', auditRequestId: 'r' })).resolves.toBe(4);
    expect(statements).toContain('ROLLBACK TO SAVEPOINT');
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      after: { retried: 4, failedEventsRetried: 4, deadSkippedOpenEvent: 1, blockedRequestsEnqueued: 0 },
    }));
  });

  it('rethrows other database errors', async () => {
    const failing = harness([]);
    const { db } = failing.repo as unknown as { db: { transaction: ReturnType<typeof vi.fn> } };
    db.transaction.mockImplementationOnce(async (handler: (t: unknown) => Promise<unknown>) => handler({
      query: async (sql: string) => {
        if (/WHERE inbound_event_id=\$1/.test(sql)) throw Object.assign(new Error('deadlock'), { code: '40P01' });
        if (/SELECT DISTINCT ON/.test(sql)) return { rows: [{ inbound_event_id: 'a' }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    }));
    await expect(failing.repo.retryFailedEvents({ actorUserId: '1', auditRequestId: 'r' })).rejects.toThrow('deadlock');
  });
});
