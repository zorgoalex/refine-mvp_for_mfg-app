import { describe, expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { CncTelegramWorkerSessionService } from '../application/cnc-telegram-worker-session.service';
import { CncTelegramWorkerSessionController } from './cnc-telegram-worker-session.controller';

describe('CncTelegramWorkerSessionController kill switch', () => {
  it.each(['claim', 'heartbeat', 'release'] as const)('blocks %s before a worker write when disabled', async (method) => {
    const service = { claim: vi.fn(), heartbeat: vi.fn(), release: vi.fn() } as unknown as CncTelegramWorkerSessionService;
    const runtimeConfig = {
      getFeatureFlags: () => ({ cncTelegramEnabled: false, backgroundIngestEnabled: false }),
    } as never;
    const controller = new CncTelegramWorkerSessionController(service, runtimeConfig);
    const request = {
      user: { id: '7', username: 'worker', role: 'worker', roleId: 4, permissions: [] },
      requestId: 'request-write',
    } as RequestWithCurrentUser;

    if (method === 'release') {
      await expect(controller.release(request, undefined, undefined, undefined, undefined, {}))
        .rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 });
    } else {
      expect(() => (method === 'claim'
        ? controller.claim(request, {})
        : controller.heartbeat(request, undefined, undefined, undefined, undefined, {})))
        .toThrowError(expect.objectContaining({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 }));
    }
    expect(service.claim).not.toHaveBeenCalled();
    expect(service.heartbeat).not.toHaveBeenCalled();
    expect(service.release).not.toHaveBeenCalled();
  });
});
