import { describe, expect, it, vi } from 'vitest';
import { PgCncTelegramWorkerSessionRepository } from './pg-cnc-telegram-worker-session-repository';

const workerInstanceId = '550e8400-e29b-41d4-a716-446655440000';

describe('PgCncTelegramWorkerSessionRepository', () => {
  it('rejects a second owner while the database considers the lease active', async () => {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('SELECT source_chat_id')) return { rows: [leaseRow({ lease_active: true })] };
        return { rows: [] };
      }),
    };
    const repository = new PgCncTelegramWorkerSessionRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repository.claim(claimInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CNC_TELEGRAM_SESSION_LEASE_BUSY',
    });
    expect(queries.some((text) => text.includes('expires_at > now() AS lease_active'))).toBe(true);
    expect(queries.some((text) => text.includes('UPDATE cnc_telegram_worker_session_leases'))).toBe(false);
  });

  it('reclaims an expired row with a fenced generation increment', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (text.includes('SELECT source_chat_id')) return { rows: [leaseRow({ lease_active: false })] };
        if (text.includes('UPDATE cnc_telegram_worker_session_leases')) {
          return { rows: [leaseRow({ lease_generation: 4, lease_token: 'n'.repeat(64) })] };
        }
        return { rows: [] };
      }),
    };
    const repository = new PgCncTelegramWorkerSessionRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repository.claim(claimInput())).resolves.toMatchObject({ leaseGeneration: 4 });
    const update = queries.find(({ text }) => text.includes('UPDATE cnc_telegram_worker_session_leases'));
    expect(update?.text).toContain('lease_generation=lease_generation+1');
    expect(update?.text).toContain('claimed_at=now(), heartbeat_at=now()');
  });

  it('rejects a stale heartbeat before extending the lease', async () => {
    const database = { query: vi.fn(async () => ({ rows: [] })) };
    const repository = new PgCncTelegramWorkerSessionRepository(database as never);

    await expect(repository.heartbeat({
      sourceChatId: '-100123',
      workerInstanceId,
      leaseToken: 't'.repeat(64),
      leaseGeneration: 2,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CNC_TELEGRAM_SESSION_LEASE_STALE',
    });
    expect(database.query.mock.calls[0]?.[0]).toContain('expires_at > now()');
  });
});

function claimInput() {
  return {
    sourceChatId: '-100123',
    workerInstanceId,
    workerImageRevision: 'image-sha',
  };
}

function leaseRow(overrides: Record<string, unknown> = {}) {
  return {
    source_chat_id: '-100123',
    lease_token: 't'.repeat(64),
    lease_generation: 3,
    worker_instance_id: workerInstanceId,
    worker_image_revision: 'image-sha',
    claimed_at: '2026-08-18T10:00:00Z',
    heartbeat_at: '2026-08-18T10:00:00Z',
    expires_at: '2026-08-18T10:01:30Z',
    ...overrides,
  };
}
