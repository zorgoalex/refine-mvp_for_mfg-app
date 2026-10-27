import { describe, expect, it, vi } from 'vitest';
import { ClientScreenController, clientScreenSettingsSchema } from './client-screen.controller';

const settings = { enabled: false, visibleCodes: ['summary.number'], version: 2, updatedAt: '2026-10-04T10:00:00.000Z' };
function build() {
  const service = {
    getSettings: vi.fn().mockResolvedValue(settings),
    updateSettings: vi.fn().mockResolvedValue({ changed: true, settings }),
  };
  return { service, controller: new ClientScreenController(service as any) };
}
const request = (over: Record<string, unknown> = {}) => ({ user: { id: '3', username: 'admin', role: 'admin', permissions: [] }, requestId: 'req-1', ...over }) as any;
const body = (over: Record<string, unknown> = {}) => ({ enabled: true, visibleCodes: ['tab.basic', 'basic.client'], expectedVersion: 2, ...over });

describe('ClientScreenController', () => {
  it('requires authentication', async () => {
    const { controller } = build();
    await expect(controller.settings(request({ user: undefined }))).rejects.toMatchObject({ statusCode: 401 });
    await expect(controller.updateSettings(request({ user: undefined }), body())).rejects.toMatchObject({ statusCode: 401 });
  });

  it('passes a valid update to the service with the actor and request id', async () => {
    const { controller, service } = build();
    await expect(controller.updateSettings(request(), body())).resolves.toEqual({ ...settings, changed: true });
    expect(service.updateSettings).toHaveBeenCalledWith({
      currentUser: request().user, requestId: 'req-1', enabled: true, visibleCodes: ['tab.basic', 'basic.client'], expectedVersion: 2,
    });
  });

  it.each([
    ['an unknown code', body({ visibleCodes: ['tab.basic', 'orders.secret'] })],
    ['a repeated code', body({ visibleCodes: ['tab.basic', 'tab.basic'] })],
    ['a missing version', { enabled: true, visibleCodes: [] }],
    ['a non-boolean switch', body({ enabled: 'yes' })],
    ['an extra key', body({ extra: 1 })],
    ['no body', undefined],
  ])('rejects %s with 422 and does not call the service', async (_name, value) => {
    const { controller, service } = build();
    await expect(controller.updateSettings(request(), value)).rejects.toMatchObject({ statusCode: 422, code: 'CLIENT_SCREEN_SETTINGS_INVALID' });
    expect(service.updateSettings).not.toHaveBeenCalled();
  });

  it('accepts an empty list: nothing is shown', () => {
    expect(clientScreenSettingsSchema.safeParse(body({ visibleCodes: [] })).success).toBe(true);
  });
});
