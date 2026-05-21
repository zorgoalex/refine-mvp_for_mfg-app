import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineInstanceDto } from '../dto/deadline-instance.dto';
import { DeadlineQueryService, buildOrderDeadlineSummary } from './deadline-query.service';
import type { DeadlineRepositoryPort } from './deadline.types';

describe('DeadlineQueryService', () => {
  it('requires deadlines.view for list reads', async () => {
    const service = new DeadlineQueryService({
      repository: createRepository(),
    });

    await expect(
      service.list({
        currentUser: currentUser([]),
        query: {
          page: 1,
          pageSize: 25,
          sortBy: 'deadlineAt',
          sortOrder: 'asc',
          onlyOverdue: false,
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
    } satisfies Partial<ApiError>);
  });

  it('builds order deadline summary from deadline instances', () => {
    const summary = buildOrderDeadlineSummary(
      42,
      [
        createDeadline({
          deadlineId: 'final',
          entityType: 'order',
          orderId: 42,
          deadlineAt: '2026-05-02T10:00:00.000Z',
          status: 'active',
        }),
        createDeadline({
          deadlineId: 'stage',
          entityType: 'order_stage',
          orderId: 42,
          orderWorkshopId: 7,
          deadlineAt: '2026-05-01T09:00:00.000Z',
          status: 'expired',
          metadata: { stageName: 'Раскрой' },
        }),
        createDeadline({
          deadlineId: 'late',
          entityType: 'order_stage',
          orderId: 42,
          deadlineAt: '2026-04-30T09:00:00.000Z',
          status: 'completed_late',
        }),
      ],
      '2026-05-01T10:00:00.000Z',
    );

    expect(summary).toMatchObject({
      orderId: 42,
      finalDeadline: {
        deadlineId: 'final',
        remainingMinutes: 1440,
      },
      currentStageDeadline: {
        deadlineId: 'stage',
        orderWorkshopId: 7,
        stageName: 'Раскрой',
      },
      counts: {
        active: 1,
        expired: 1,
        completedLate: 1,
        completedOnTime: 0,
      },
    });
  });
});

function currentUser(permissions = getPermissionsForRole('manager')): CurrentUser {
  return {
    id: 'u1',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions,
  };
}

function createRepository(): DeadlineRepositoryPort {
  return {
    async listDeadlines() {
      return { data: [], total: 0 };
    },
    async getDeadlineById() {
      return null;
    },
    async getDeadlineByIdForUpdate() {
      return null;
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
    async createDeadlineInstance() {
      throw new Error('not implemented');
    },
    async overrideDeadline() {
      throw new Error('not implemented');
    },
    async pauseDeadline() {
      throw new Error('not implemented');
    },
    async resumeDeadline() {
      throw new Error('not implemented');
    },
    async cancelDeadline() {
      throw new Error('not implemented');
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
  };
}

function createDeadline(overrides: Partial<DeadlineInstanceDto>): DeadlineInstanceDto {
  return {
    deadlineId: 'deadline',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    orderWorkshopId: null,
    clientId: null,
    responsibleUserId: null,
    deadlineAt: '2026-05-02T10:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    metadata: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
