import { describe, expect, it, vi } from 'vitest';
import type { CncTelegramWorkerSessionService } from './cnc-telegram-worker-session.service';
import type { CncTelegramMdfObservationRepositoryPort } from './mdf-cnc-observations.types';
import { CncTelegramMdfObservationService } from './mdf-cnc-observations.service';

const user = { id: '44', username: 'worker', role: 'worker', permissions: ['cut.manage'] } as never;
const lease = {
  sourceChatId: '', leaseToken: 'a'.repeat(64), leaseGeneration: 2,
  workerInstanceId: 'bbd8d32d-87bb-4ce9-900a-38c145fe5967',
};
const authorizedLease = { ...lease, sourceChatId: '-100123' };
const report = {
  claimId: '0d7080d2-6d9d-4f38-9628-23f9e92b0b11', claimToken: 'b'.repeat(64), claimGeneration: 3,
  messages: [{ messageId: 7, chatId: '-100123', role: 'svg' as const, sha256: 'c'.repeat(64), present: true as const, thumbsUp: false }],
};

describe('CncTelegramMdfObservationService', () => {
  it('normalizes the optional one-chat header and revalidates worker lease before repository claim', async () => {
    const { service, repository, session } = setup();
    repository.claim.mockResolvedValue(null);
    await expect(service.claim(user, lease)).resolves.toEqual({ claim: null });
    expect(session.resolveChatId).toHaveBeenCalledWith('');
    expect(session.assertCurrent).toHaveBeenCalledWith(user, authorizedLease);
    expect(repository.claim).toHaveBeenCalledWith({ currentUser: user, lease: authorizedLease });
  });

  it('rechecks worker authorization before each report and delegates without wrapping a second transaction', async () => {
    const { service, repository, session } = setup();
    const result = { status: 'recorded', observationVersion: '9', fenceState: 'waiting_completion', jobId: null };
    repository.complete.mockResolvedValue(result);
    await expect(service.complete({ currentUser: user, lease, report, requestId: 'request-9' })).resolves.toEqual(result);
    expect(session.assertCurrent).toHaveBeenCalledWith(user, authorizedLease);
    expect(repository.complete).toHaveBeenCalledWith({ currentUser: user, lease: authorizedLease, report, requestId: 'request-9' });
    expect(repository).not.toHaveProperty('transaction');
  });

  it('binds fail operations to authorized session and returns a stable acknowledgment', async () => {
    const { service, repository, session } = setup();
    await expect(service.fail({ currentUser: user, lease, claimId: report.claimId, claimToken: report.claimToken,
      claimGeneration: 3, reason: 'MESSAGE_MISSING', requestId: 'request-fail' })).resolves.toEqual({ failed: true });
    expect(session.assertCurrent).toHaveBeenCalledWith(user, authorizedLease);
    expect(repository.fail).toHaveBeenCalledWith({ currentUser: user, lease: authorizedLease,
      claimId: report.claimId, claimToken: report.claimToken, claimGeneration: 3,
      reason: 'MESSAGE_MISSING', requestId: 'request-fail' });
  });

  it.each(['claim', 'complete', 'fail'] as const)('does not delegate %s if worker session authorization fails', async method => {
    const { service, repository, session } = setup();
    session.assertCurrent.mockRejectedValue(new Error('stale lease'));
    const call = method === 'claim'
      ? service.claim(user, lease)
      : method === 'complete'
        ? service.complete({ currentUser: user, lease, report, requestId: 'request-9' })
        : service.fail({ currentUser: user, lease, claimId: report.claimId, claimToken: report.claimToken,
          claimGeneration: 3, reason: 'FETCH_FAILED', requestId: 'request-fail' });
    await expect(call).rejects.toThrow('stale lease');
    expect(repository.claim).not.toHaveBeenCalled();
    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).not.toHaveBeenCalled();
  });
});

function setup() {
  const repository = {
    claim: vi.fn(), complete: vi.fn(), fail: vi.fn(),
  } as unknown as CncTelegramMdfObservationRepositoryPort & { claim: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> };
  const session = {
    resolveChatId: vi.fn(() => '-100123'),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
  } as unknown as CncTelegramWorkerSessionService & { resolveChatId: ReturnType<typeof vi.fn>; assertCurrent: ReturnType<typeof vi.fn> };
  return { repository, session, service: new CncTelegramMdfObservationService(repository, session) };
}
