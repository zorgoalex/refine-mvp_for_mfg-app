import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CncTelegramWorkerSessionLeaseContext,
  CncTelegramWorkerSessionLeaseDto,
  CncTelegramWorkerSessionLeaseRepositoryPort,
} from './cnc-telegram-worker-session.types';
import { CncTelegramWorkerSessionService } from './cnc-telegram-worker-session.service';

const context: CncTelegramWorkerSessionLeaseContext = {
  sourceChatId: '-100123',
  leaseToken: 't'.repeat(64),
  leaseGeneration: 3,
  workerInstanceId: '550e8400-e29b-41d4-a716-446655440000',
};

describe('CncTelegramWorkerSessionService', () => {
  it('requires exact worker username, cut.manage, and an allowed chat', async () => {
    const repository = repositoryMock();
    const service = new CncTelegramWorkerSessionService(repository, config());
    const dto: CncTelegramWorkerSessionLeaseDto = {
      sourceChatId: '-100123',
      workerInstanceId: context.workerInstanceId,
      workerImageRevision: 'image-sha',
    };

    await expect(service.claim(user('operator', ['cut.manage']), dto)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.claim(user('cnc-worker', []), dto)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.claim(user('cnc-worker', ['cut.manage']), { ...dto, sourceChatId: '-100999' }))
      .rejects.toMatchObject({ code: 'CNC_TELEGRAM_CHAT_DENIED', statusCode: 403 });
    expect(repository.claim).not.toHaveBeenCalled();
  });

  it('fences current-session assertions by token, generation, and worker instance', async () => {
    const repository = repositoryMock();
    const service = new CncTelegramWorkerSessionService(repository, config());

    await service.assertCurrent(user('cnc-worker', ['cut.manage']), context);

    expect(repository.assertCurrent).toHaveBeenCalledWith(context);
  });

  it('derives the sole configured chat when the worker omits the optional chat header', async () => {
    const repository = repositoryMock();
    const service = new CncTelegramWorkerSessionService(repository, config());

    await service.assertCurrent(user('cnc-worker', ['cut.manage']), { ...context, sourceChatId: '' });

    expect(repository.assertCurrent).toHaveBeenCalledWith({ ...context, sourceChatId: '-100123' });
  });
});

function repositoryMock(): CncTelegramWorkerSessionLeaseRepositoryPort {
  return {
    claim: vi.fn().mockResolvedValue({}),
    heartbeat: vi.fn().mockResolvedValue({}),
    assertCurrent: vi.fn().mockResolvedValue(undefined),
  };
}

function config(): ConfigService<BackendEnv, true> {
  return {
    get: vi.fn((key: keyof BackendEnv) => ({
      CNC_TELEGRAM_WORKER_USERNAME: 'cnc-worker',
      CNC_TELEGRAM_ALLOWED_CHAT_IDS: '-100123',
    })[key]),
  } as unknown as ConfigService<BackendEnv, true>;
}

function user(username: string, permissions: CurrentUser['permissions']): CurrentUser {
  return { id: '7', username, role: 'admin', roleId: 1, permissions };
}
