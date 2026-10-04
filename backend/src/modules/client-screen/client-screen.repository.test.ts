import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../../common/audit/audit.service';
import { ClientScreenRepository } from './client-screen.repository';

interface Row { enabled: boolean; visible_codes: string[]; version: string; updated_at: Date }

/** Fake database with the one settings row; records every statement. */
function build(row: Row | null, actorExists = true) {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const state = { row };
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      if (/FROM users/.test(sql)) return { rows: actorExists ? [{ username: 'admin' }] : [] };
      if (/^\s*UPDATE client_screen_settings/.test(sql)) {
        state.row = { enabled: params[0] as boolean, visible_codes: params[1] as string[], version: String(Number(state.row!.version) + 1), updated_at: new Date('2026-10-04T11:00:00.000Z') };
        return { rows: [] };
      }
      if (/FROM client_screen_settings/.test(sql)) return { rows: state.row ? [state.row] : [] };
      throw new Error(`unexpected statement: ${sql}`);
    }),
  };
  const database = { query: client.query, transaction: vi.fn(async (handler: (tx: typeof client) => Promise<unknown>) => handler(client)) };
  return { statements, state, repository: new ClientScreenRepository(database as any) };
}
const stored = (): Row => ({ enabled: false, visible_codes: ['tab.basic', 'basic.client', 'gone.code'], version: '4', updated_at: new Date('2026-10-04T10:00:00.000Z') });
const command = (over: Record<string, unknown> = {}) => ({
  currentUser: { id: '3', username: 'admin', role: 'admin', permissions: ['settings.manage'] } as any,
  requestId: 'req-9', enabled: false, visibleCodes: ['tab.basic', 'basic.client'] as any, expectedVersion: 4, ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('ClientScreenRepository', () => {
  it('reads the row, dropping codes that are no longer in the registry', async () => {
    const { repository } = build(stored());
    await expect(repository.getSettings()).resolves.toEqual({
      enabled: false, visibleCodes: ['tab.basic', 'basic.client'], version: 4, updatedAt: '2026-10-04T10:00:00.000Z',
    });
  });

  it('answers 503 when the row is missing', async () => {
    const { repository } = build(null);
    await expect(repository.getSettings()).rejects.toMatchObject({ statusCode: 503, code: 'CLIENT_SCREEN_SETTINGS_MISSING' });
  });

  it('treats the same values as a no-op: no update, no version bump, no audit, even with a stale version', async () => {
    const { repository, statements } = build(stored());
    const record = vi.spyOn(auditService, 'record');
    const result = await repository.updateSettings(command({ visibleCodes: ['basic.client', 'tab.basic'], expectedVersion: 1 }));
    expect(result).toMatchObject({ changed: false, settings: { version: 4 } });
    expect(statements.some((statement) => /UPDATE client_screen_settings/.test(statement.sql))).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('locks the row, replaces it in registry order, bumps the version and audits in the same transaction', async () => {
    const { repository, statements } = build(stored());
    const record = vi.spyOn(auditService, 'record').mockResolvedValue('1' as any);
    const result = await repository.updateSettings(command({ enabled: true, visibleCodes: ['details.name', 'tab.details', 'tab.basic'] }));
    expect(result).toEqual({
      changed: true,
      settings: { enabled: true, visibleCodes: ['tab.basic', 'tab.details', 'details.name'], version: 5, updatedAt: '2026-10-04T11:00:00.000Z' },
    });
    expect(statements.some((statement) => /FOR UPDATE OF s/.test(statement.sql))).toBe(true);
    const update = statements.find((statement) => /UPDATE client_screen_settings/.test(statement.sql))!;
    expect(update.params).toEqual([true, ['tab.basic', 'tab.details', 'details.name'], 3]);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][1]).toMatchObject({
      event: 'client_screen.settings_updated', entityType: 'client_screen_settings', entityId: '1',
      actorUserId: 3, actorUsername: 'admin', actorRole: 'admin', requestId: 'req-9', source: 'backend-client-screen',
      before: { enabled: false, visibleCodes: ['tab.basic', 'basic.client'], version: 4 },
      after: { enabled: true, visibleCodes: ['tab.basic', 'tab.details', 'details.name'], version: 5 },
      metadata: { correlationId: 'req-9' },
    });
    expect(Object.keys(record.mock.calls[0][1].diff ?? {}).sort()).toEqual(['enabled', 'visibleCodes']);
  });

  it('audits the master switch alone', async () => {
    const { repository } = build(stored());
    const record = vi.spyOn(auditService, 'record').mockResolvedValue('1' as any);
    await repository.updateSettings(command({ enabled: true }));
    expect(Object.keys(record.mock.calls[0][1].diff ?? {})).toEqual(['enabled']);
  });

  it('answers 409 with the current settings on a stale version and changes nothing', async () => {
    const { repository, statements } = build(stored());
    const record = vi.spyOn(auditService, 'record');
    await expect(repository.updateSettings(command({ enabled: true, expectedVersion: 3 }))).rejects.toMatchObject({
      statusCode: 409, code: 'CLIENT_SCREEN_SETTINGS_VERSION_CONFLICT', details: { settings: { version: 4, enabled: false } },
    });
    expect(statements.some((statement) => /UPDATE client_screen_settings/.test(statement.sql))).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an actor that is not an active ERP user', async () => {
    const { repository, statements } = build(stored(), false);
    await expect(repository.updateSettings(command({ enabled: true }))).rejects.toMatchObject({ statusCode: 403, code: 'CLIENT_SCREEN_ACTOR_INVALID' });
    expect(statements.some((statement) => /UPDATE client_screen_settings/.test(statement.sql))).toBe(false);
  });
});
