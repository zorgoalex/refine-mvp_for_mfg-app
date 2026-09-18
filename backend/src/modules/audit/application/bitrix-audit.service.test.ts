import { describe, expect, it, vi } from 'vitest';
import { BitrixAuditService } from './bitrix-audit.service';
import type { CurrentUser } from '../../../permissions/current-user';
const user: CurrentUser = { id: '1', username: 'E2E-audit', role: 'admin', roleId: 1, permissions: ['audit.view'] };
describe('BitrixAuditService read-only boundary', () => {
  it.each(['status', 'eventOptions', 'queue'] as const)('requires audit.view for %s', async (method) => {
    const query = vi.fn(); const service = new BitrixAuditService({ query }, {} as never);
    const call = (actor?: CurrentUser) => method === 'queue' ? service.queue(actor, { direction: 'forward', page: 1, pageSize: 50 }) : service[method](actor);
    await expect(call()).rejects.toMatchObject({ statusCode: 401 });
    await expect(call({ ...user, role: 'manager', permissions: [] })).rejects.toMatchObject({ statusCode: 403 });
    expect(query).not.toHaveBeenCalled();
  });
  it('exposes only whitelisted runtime fields, never config secrets', async () => {
    const config = { getFlags: () => ({ enabled: true, relayOwner: 'external', dryRun: false, secret: 'DO-NOT-EXPOSE' }) };
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ direction: 'forward', pending: '31', processing: '0', failed: '2', dead: '0', oldest: null, last: null }] }) };
    const result = await new BitrixAuditService(db, config as never).status(user);
    expect(result.data[0]).toMatchObject({ owner: 'external', pending: 31, lastProcessedAt: null });
    expect(JSON.stringify(result)).not.toContain('DO-NOT-EXPOSE');
  });
});
