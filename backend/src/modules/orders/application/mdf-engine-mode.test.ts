import { describe, expect, it, vi, afterEach } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { MdfActiveProductionReturnService } from './mdf-active-production-return.service';

const user = (permissions: string[]): CurrentUser => ({ id: '7', username: 'u', role: 'manager', roleId: 2, permissions } as CurrentUser);
function serviceWith(rows: { mode: string }[]) {
  const queries: string[] = [];
  const database = { transaction: async <T>(run: (tx: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<T>) =>
    run({ query: async (sql: string) => { queries.push(sql); return { rows: sql.includes('mdf_engine_state') ? rows : [] }; } }) };
  return { service: new MdfActiveProductionReturnService(database as never), queries };
}

describe('MDF engine mode (§5.5 return dialog selection)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns the authoritative mode under the shared cutover lock and never writes', async () => {
    vi.stubEnv('BACKEND_MDF_PUBLISHED_READS', 'true');
    for (const mode of ['legacy', 'shadow', 'active', 'read_only']) {
      const { service, queries } = serviceWith([{ mode }]);
      await expect(service.engineMode(user(['orders.view']))).resolves.toEqual({ mode, publishedReads: true });
      expect(queries[0]).toContain('pg_advisory_xact_lock_shared');
      expect(queries.some(sql => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
    }
  });

  it('reports published reads off and refuses without orders.view or with an unknown state', async () => {
    const { service } = serviceWith([{ mode: 'legacy' }]);
    await expect(service.engineMode(user(['orders.view']))).resolves.toEqual({ mode: 'legacy', publishedReads: false });
    await expect(service.engineMode(user([]))).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    await expect(serviceWith([]).service.engineMode(user(['orders.view'])))
      .rejects.toMatchObject({ statusCode: 503, code: 'MDF_ENGINE_STATE_UNAVAILABLE' });
    await expect(serviceWith([{ mode: 'weird' }]).service.engineMode(user(['orders.view'])))
      .rejects.toMatchObject({ statusCode: 503 });
  });
});
