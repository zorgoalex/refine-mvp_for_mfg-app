import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { ExportTemplatesService } from './export-templates.service';

const source = readFileSync(new URL('./export-templates.service.ts', import.meta.url), 'utf8');

describe('ExportTemplatesService setDefault lock order', () => {
  it('takes the target-scoped advisory lock before any target row lock', () => {
    const method = source.slice(source.indexOf('async setDefault('), source.indexOf('private async queryList'));
    const metadataRead = method.indexOf('const targetMetadata = await this.load(tx, id);');
    const advisoryLock = method.indexOf("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))");
    const targetRowLock = method.indexOf('const target = await this.load(tx, id, true);');

    expect(metadataRead).toBeGreaterThan(-1);
    expect(advisoryLock).toBeGreaterThan(metadataRead);
    expect(targetRowLock).toBeGreaterThan(advisoryLock);
  });
});

describe('ExportTemplatesService idempotency scope', () => {
  const user: CurrentUser = {
    id: '11', username: 'admin', role: 'admin', roleId: 4, permissions: ['settings.manage'],
  };

  it('rejects replaying a set-default key as delete even when payload hashes match', async () => {
    const service = new ExportTemplatesService(fakeReplayDatabase({ command_name: 'export_template.set_default' }));

    await expect(service.delete(user, 'req-delete', 7, {
      expectedVersion: 3,
      idempotencyKey: 'shared-command-key',
    })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('rejects replay owned by another actor', async () => {
    const service = new ExportTemplatesService(fakeReplayDatabase({ actor_user_id: '12' }));

    await expect(service.delete(user, 'req-delete', 7, {
      expectedVersion: 3,
      idempotencyKey: 'other-actor-key',
    })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

function fakeReplayDatabase(overrides: Partial<{
  command_name: string;
  actor_user_id: string;
  entity_type: string;
  entity_id: string;
}>): DatabaseService {
  let requestHash = '';
  const tx = {
    raw: {},
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      if (text.includes('set_config')) return queryResult([]);
      if (text.includes('INSERT INTO command_idempotency_keys')) {
        requestHash = String(params[5]);
        return queryResult([], 0);
      }
      if (text.includes('FROM command_idempotency_keys')) {
        return queryResult([{
          request_hash: requestHash,
          response_json: { deleted: true },
          status: 'completed',
          command_name: 'export_template.delete',
          actor_user_id: '11',
          entity_type: 'export_template',
          entity_id: '7',
          ...overrides,
        }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    }),
  } as unknown as TransactionClient;
  return {
    transaction: async <T>(handler: (client: TransactionClient) => Promise<T>) => handler(tx),
  } as unknown as DatabaseService;
}

function queryResult<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}
