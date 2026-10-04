import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../../common/audit/audit.service';
import { PermissionsService } from '../../permissions/permissions.service';
import { ClientScreenService } from './client-screen.service';

const settings = { enabled: true, visibleCodes: ['summary.number'], version: 3, updatedAt: '2026-10-04T10:00:00.000Z' };
const user = (permissions: string[]) => ({ id: '7', username: 'u', role: 'manager', roleId: 2, permissions }) as any;

function build() {
  const repository = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue({ changed: true, settings }),
  };
  const auditClient = { query: vi.fn() };
  return { repository, auditClient, service: new ClientScreenService(repository as any, new PermissionsService(), auditClient as any) };
}
const command = (permissions: string[]) => ({
  currentUser: user(permissions), requestId: 'req-1', enabled: true, visibleCodes: ['summary.number'] as any, expectedVersion: 3,
});

afterEach(() => vi.restoreAllMocks());

describe('ClientScreenService permissions', () => {
  it.each([['orders.view'], ['settings.manage']])('lets %s read the settings', async (permission) => {
    const { service } = build();
    await expect(service.getSettings(user([permission]))).resolves.toEqual(settings);
  });

  it('refuses to read without orders.view or settings.manage', async () => {
    const { service, repository } = build();
    await expect(service.getSettings(user(['payments.view']))).rejects.toMatchObject({
      statusCode: 403, code: 'PERMISSION_DENIED', details: { requiredPermissions: ['orders.view', 'settings.manage'] },
    });
    expect(repository.getSettings).not.toHaveBeenCalled();
  });

  it('updates with settings.manage', async () => {
    const { service, repository } = build();
    const denied = vi.spyOn(auditService, 'recordDenied');
    await expect(service.updateSettings(command(['settings.manage']))).resolves.toEqual({ changed: true, settings });
    expect(repository.updateSettings).toHaveBeenCalledTimes(1);
    expect(denied).not.toHaveBeenCalled();
  });

  it('refuses an update without settings.manage, writes the denied audit and never reaches the repository', async () => {
    const { service, repository, auditClient } = build();
    const denied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('1' as any);
    await expect(service.updateSettings(command(['orders.view']))).rejects.toMatchObject({
      statusCode: 403, code: 'PERMISSION_DENIED', details: { requiredPermissions: ['settings.manage'] },
    });
    expect(repository.updateSettings).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith(auditClient, expect.objectContaining({
      event: 'client_screen.settings_denied', entityType: 'client_screen_settings', entityId: '1',
      actorUserId: '7', actorUsername: 'u', actorRole: 'manager', requestId: 'req-1',
      source: 'backend-client-screen', reason: 'missing_permission', requiredPermissions: ['settings.manage'],
    }));
  });
});
