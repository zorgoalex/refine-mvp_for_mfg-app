import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlineCommandService } from './deadline-command.service';
import type { DeadlineRepositoryPort, DeadlineTransactionManagerPort } from './deadline.types';

describe('DeadlineCommandService', () => {
  it('requires deadlines.manage to create manual deadlines', async () => {
    const service = new DeadlineCommandService({
      transactions: transactionManager(createRepository()),
    });

    await expect(
      service.create({
        currentUser: currentUser([]),
        dto: {
          entityType: 'order',
          entityId: '42',
          deadlineAt: '2026-05-02T10:00:00.000Z',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('delegates create through transaction with request id', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async createDeadlineInstance(command) {
            calls.push(
              `create:${command.currentUser.id}:${command.requestId}:${command.dto.entityType}:${command.dto.entityId}:${command.dto.deadlineAt}`,
            );
            return createDeadline({
              entityType: command.dto.entityType,
              entityId: command.dto.entityId,
              deadlineAt: command.dto.deadlineAt,
            });
          },
        }),
      ),
    });

    await expect(
      service.create({
        currentUser: currentUser(),
        requestId: 'req-create-1',
        dto: {
          entityType: 'order',
          entityId: '42',
          deadlineAt: '2026-05-02T10:00:00.000Z',
        },
      }),
    ).resolves.toMatchObject({
      entityType: 'order',
      entityId: '42',
      deadlineAt: '2026-05-02T10:00:00.000Z',
    });

    expect(calls).toEqual(['create:u1:req-create-1:order:42:2026-05-02T10:00:00.000Z']);
  });

  it('requires deadlines.override to override manual deadlines', async () => {
    const service = new DeadlineCommandService({
      transactions: transactionManager(createRepository()),
    });

    await expect(
      service.override({
        currentUser: currentUser([]),
        deadlineId: 'deadline-id',
        requestId: 'req-override-denied',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('delegates override through transaction after locking mutable deadline', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'active' });
          },
          async getDeadlineById(deadlineId) {
            calls.push(`read:${deadlineId}`);
            return createDeadline({ status: 'active' });
          },
          async overrideDeadline(command) {
            calls.push(
              `override:${command.deadlineId}:${command.requestId}:${command.dto.deadlineAt}:${command.dto.reason}`,
            );
            return createDeadline({ isManuallyOverridden: true });
          },
        }),
      ),
    });

    await expect(
      service.override({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-override-1',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        },
      }),
    ).resolves.toMatchObject({ isManuallyOverridden: true });

    expect(calls).toEqual([
      'lock:deadline-id',
      'override:deadline-id:req-override-1:2026-05-03T10:00:00.000Z:Manual correction',
    ]);
  });

  it('rejects override for terminal deadlines after locking the row', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'completed_on_time' });
          },
          async overrideDeadline() {
            calls.push('override');
            return createDeadline({ isManuallyOverridden: true });
          },
        }),
      ),
    });

    await expect(
      service.override({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-override-terminal',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    } satisfies Partial<ApiError>);

    expect(calls).toEqual(['lock:deadline-id']);
  });

  it('delegates override retry when the original deadline is already superseded and request id is present', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'superseded' });
          },
          async overrideDeadline(command) {
            calls.push(`override:${command.deadlineId}:${command.requestId}`);
            return createDeadline({
              deadlineId: 'replacement-deadline-id',
              deadlineAt: command.dto.deadlineAt,
              isManuallyOverridden: true,
            });
          },
        }),
      ),
    });

    await expect(
      service.override({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-override-1',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        },
      }),
    ).resolves.toMatchObject({
      deadlineId: 'replacement-deadline-id',
      isManuallyOverridden: true,
    });

    expect(calls).toEqual(['lock:deadline-id', 'override:deadline-id:req-override-1']);
  });

  it('rejects override retry for superseded deadlines without a request id', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'superseded' });
          },
          async overrideDeadline() {
            calls.push('override');
            return createDeadline({ isManuallyOverridden: true });
          },
        }),
      ),
    });

    await expect(
      service.override({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        dto: {
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    } satisfies Partial<ApiError>);

    expect(calls).toEqual(['lock:deadline-id']);
  });

  it('rejects pause for non-active deadlines after locking the row', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'completed_on_time' });
          },
          async pauseDeadline() {
            calls.push('pause');
            return createDeadline({ status: 'paused' });
          },
        }),
      ),
    });

    await expect(
      service.pause({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-pause-invalid',
        dto: {
          pauseMode: 'pause_and_shift_deadline',
          pauseReason: 'Ожидание клиента',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    } satisfies Partial<ApiError>);
    expect(calls).toEqual(['lock:deadline-id']);
  });

  it('delegates pause through transaction after locked status check', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'active' });
          },
          async pauseDeadline(command) {
            calls.push(
              `pause:${command.deadlineId}:${command.dto.pauseMode}:${command.dto.pauseReason}:${command.requestId}`,
            );
            return createDeadline({ status: 'paused' });
          },
        }),
      ),
    });

    await expect(
      service.pause({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-pause-1',
        dto: {
          pauseMode: 'pause_without_shift',
          pauseReason: 'Ожидание клиента',
        },
      }),
    ).resolves.toMatchObject({ status: 'paused' });
    expect(calls).toEqual([
      'lock:deadline-id',
      'pause:deadline-id:pause_without_shift:Ожидание клиента:req-pause-1',
    ]);
  });

  it('delegates resume through transaction after locked status check', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'paused' });
          },
          async resumeDeadline(command) {
            calls.push(`resume:${command.deadlineId}:${command.dto.notes}:${command.requestId}`);
            return createDeadline({ status: 'active' });
          },
        }),
      ),
    });

    await expect(
      service.resume({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-resume-1',
        dto: { notes: 'Client replied' },
      }),
    ).resolves.toMatchObject({ status: 'active' });
    expect(calls).toEqual([
      'lock:deadline-id',
      'resume:deadline-id:Client replied:req-resume-1',
    ]);
  });

  it('rejects resume for non-paused deadlines after locking the row', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'active' });
          },
          async resumeDeadline() {
            calls.push('resume');
            return createDeadline({ status: 'active' });
          },
        }),
      ),
    });

    await expect(
      service.resume({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-resume-invalid',
        dto: {},
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    } satisfies Partial<ApiError>);
    expect(calls).toEqual(['lock:deadline-id']);
  });

  it('delegates cancel through transaction after locked status check', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'active' });
          },
          async cancelDeadline(command) {
            calls.push(`cancel:${command.deadlineId}:${command.dto.reason}:${command.requestId}`);
            return createDeadline({ status: 'cancelled' });
          },
        }),
      ),
    });

    await expect(
      service.cancel({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-cancel-1',
        dto: { reason: 'Заказ отменен' },
      }),
    ).resolves.toMatchObject({ status: 'cancelled' });
    expect(calls).toEqual([
      'lock:deadline-id',
      'cancel:deadline-id:Заказ отменен:req-cancel-1',
    ]);
  });

  it('rejects repeated cancel before repository writes terminal events', async () => {
    const calls: string[] = [];
    const service = new DeadlineCommandService({
      transactions: transactionManager(
        createRepository({
          async getDeadlineByIdForUpdate(deadlineId) {
            calls.push(`lock:${deadlineId}`);
            return createDeadline({ status: 'cancelled' });
          },
          async cancelDeadline() {
            calls.push('cancel');
            return createDeadline({ status: 'cancelled' });
          },
        }),
      ),
    });

    await expect(
      service.cancel({
        currentUser: currentUser(),
        deadlineId: 'deadline-id',
        requestId: 'req-cancel-2',
        dto: { reason: 'Повторная отмена' },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'DEADLINE_INVALID_STATUS_TRANSITION',
    } satisfies Partial<ApiError>);
    expect(calls).toEqual(['lock:deadline-id']);
  });
});

function currentUser(permissions = getPermissionsForRole('admin')): CurrentUser {
  return {
    id: 'u1',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions,
  };
}

function transactionManager(repository: DeadlineRepositoryPort): DeadlineTransactionManagerPort {
  return {
    async runInTransaction(handler) {
      return handler({ deadlines: repository });
    },
  };
}

function createRepository(overrides: Partial<DeadlineRepositoryPort> = {}): DeadlineRepositoryPort {
  return {
    async listDeadlines() {
      return { data: [], total: 0 };
    },
    async getDeadlineById() {
      return createDeadline();
    },
    async getDeadlineByIdForUpdate() {
      return createDeadline();
    },
    async listOrderDeadlines() {
      return [];
    },
    async listOrderDeadlineEvents() {
      return [];
    },
    async listPolicies() {
      return [];
    },
    async createPolicy() {
      throw new Error('not implemented');
    },
    async updatePolicy() {
      throw new Error('not implemented');
    },
    async getSettings() {
      throw new Error('not implemented');
    },
    async updateSettings() {
      throw new Error('not implemented');
    },
    async createDeadlineInstance(command) {
      return createDeadline({
        entityType: command.dto.entityType,
        entityId: command.dto.entityId,
        deadlineAt: command.dto.deadlineAt,
      });
    },
    async overrideDeadline() {
      return createDeadline({ isManuallyOverridden: true });
    },
    async pauseDeadline() {
      return createDeadline({ status: 'paused' });
    },
    async resumeDeadline() {
      return createDeadline({ status: 'active' });
    },
    async cancelDeadline() {
      return createDeadline({ status: 'cancelled' });
    },
    async findDueDeadlinesForUpdate() {
      return [];
    },
    async markDeadlineExpired() {
      throw new Error('not implemented');
    },
    async markDeadlineCompleted() {
      throw new Error('not implemented');
    },
    async createDeadlineEvent() {
      throw new Error('not implemented');
    },
    async listActionRules() {
      return [];
    },
    async createActionExecution() {
      throw new Error('not implemented');
    },
    ...overrides,
  };
}

function createDeadline(overrides: Partial<DeadlineInstanceDto> = {}): DeadlineInstanceDto {
  return {
    deadlineId: 'deadline-id',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-02T10:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
