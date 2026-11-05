import { describe, expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { CncTelegramMdfObservationService } from '../application/mdf-cnc-observations.service';
import { CncTelegramObservationWorkerController } from './cnc-telegram-observation-worker.controller';

const user = { id: '44', username: 'worker', role: 'worker', roleId: 4, permissions: ['cut.manage'] };
const claimId = '0d7080d2-6d9d-4f38-9628-23f9e92b0b11';
const headers = {
  token: 'a'.repeat(64), generation: '3', chat: undefined,
  worker: 'bbd8d32d-87bb-4ce9-900a-38c145fe5967',
};
const report = {
  claimId,
  claimToken: 'c'.repeat(64),
  claimGeneration: 1,
  messages: [{
    messageId: 10, chatId: '-100123', role: 'svg', sha256: 'd'.repeat(64), present: true, thumbsUp: false,
  }],
};

describe('CncTelegramObservationWorkerController', () => {
  it('returns a server-selected claim and resolves the optional single-chat header downstream', async () => {
    const service = { claim: vi.fn().mockResolvedValue({ claim: null }) } as unknown as CncTelegramMdfObservationService;
    const controller = new CncTelegramObservationWorkerController(service, enabledConfig());
    await expect(controller.claim(request(), headers.token, headers.generation, headers.chat, headers.worker))
      .resolves.toEqual({ claim: null });
    expect(service.claim).toHaveBeenCalledWith(user, {
      sourceChatId: '', leaseToken: headers.token, leaseGeneration: 3, workerInstanceId: headers.worker,
    });
  });

  it('passes only strict claim-bound group facts to complete', async () => {
    const service = { complete: vi.fn().mockResolvedValue({ status: 'recorded', observationVersion: '12',
      fenceState: 'waiting_pending', jobId: null }) } as unknown as CncTelegramMdfObservationService;
    const controller = new CncTelegramObservationWorkerController(service, enabledConfig());
    const result = await controller.complete(request(), claimId, headers.token, headers.generation, '-100123', headers.worker, report);
    expect(result).toMatchObject({ status: 'recorded', observationVersion: '12' });
    expect(service.complete).toHaveBeenCalledWith(expect.objectContaining({
      currentUser: user,
      lease: { sourceChatId: '-100123', leaseToken: headers.token, leaseGeneration: 3, workerInstanceId: headers.worker },
      report,
      requestId: 'request-1',
    }));
  });

  it('rejects path/body claim mismatch before any service write', async () => {
    const service = { complete: vi.fn() } as unknown as CncTelegramMdfObservationService;
    const controller = new CncTelegramObservationWorkerController(service, enabledConfig());
    await expect(Promise.resolve().then(() => controller.complete(request(), 'cc4e1bc0-c4f7-4fea-a52c-4e11753c21f3', headers.token,
      headers.generation, '-100123', headers.worker, report)))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 });
    expect(service.complete).not.toHaveBeenCalled();
  });

  it('passes a bounded failure reason and server request id', async () => {
    const service = { fail: vi.fn().mockResolvedValue({ failed: true }) } as unknown as CncTelegramMdfObservationService;
    const controller = new CncTelegramObservationWorkerController(service, enabledConfig());
    await expect(controller.fail(request(), claimId, headers.token, headers.generation, '-100123', headers.worker, {
      claimToken: 'c'.repeat(64), claimGeneration: 2, reason: 'MESSAGE_MEDIA_MISMATCH',
    })).resolves.toEqual({ failed: true });
    expect(service.fail).toHaveBeenCalledWith(expect.objectContaining({
      currentUser: user,
      lease: { sourceChatId: '-100123', leaseToken: headers.token, leaseGeneration: 3, workerInstanceId: headers.worker },
      claimId,
      claimToken: 'c'.repeat(64),
      claimGeneration: 2,
      reason: 'MESSAGE_MEDIA_MISMATCH',
      requestId: 'request-1',
    }));
  });

  it.each(['claim', 'complete', 'fail'] as const)('blocks %s before delegation while CNC Telegram is disabled', async method => {
    const service = { claim: vi.fn(), complete: vi.fn(), fail: vi.fn() } as unknown as CncTelegramMdfObservationService;
    const controller = new CncTelegramObservationWorkerController(service, enabledConfig(false));
    const call = Promise.resolve().then(() => method === 'claim'
      ? controller.claim(request(), headers.token, headers.generation, '-100123', headers.worker)
      : method === 'complete'
        ? controller.complete(request(), claimId, headers.token, headers.generation, '-100123', headers.worker, report)
        : controller.fail(request(), claimId, headers.token, headers.generation, '-100123', headers.worker, {
          claimToken: 'c'.repeat(64), claimGeneration: 1, reason: 'FETCH_FAILED',
        }));
    await expect(call).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', statusCode: 503 });
    expect(service.claim).not.toHaveBeenCalled();
    expect(service.complete).not.toHaveBeenCalled();
    expect(service.fail).not.toHaveBeenCalled();
  });

  it('requires authenticated current user', async () => {
    const service = { claim: vi.fn() } as unknown as CncTelegramMdfObservationService;
    const controller = new CncTelegramObservationWorkerController(service, enabledConfig());
    await expect(Promise.resolve().then(() => controller.claim(request(false), headers.token, headers.generation, '-100123', headers.worker)))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', statusCode: 401 });
    expect(service.claim).not.toHaveBeenCalled();
  });
});

function request(withUser = true): RequestWithCurrentUser {
  return { user: withUser ? user : undefined, requestId: 'request-1' } as unknown as RequestWithCurrentUser;
}

function enabledConfig(enabled = true) {
  return { getFeatureFlags: () => ({ cncTelegramEnabled: enabled, backgroundIngestEnabled: false, manualImportEnabled: true }) } as never;
}
