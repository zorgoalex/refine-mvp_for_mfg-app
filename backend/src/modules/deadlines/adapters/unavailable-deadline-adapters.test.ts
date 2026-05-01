import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { UnavailableDeadlineNotificationPort } from './unavailable-deadline-notification-port';
import { UnavailableDeadlineRepository } from './unavailable-deadline-repository';
import { UnavailableDeadlineTargetResolver } from './unavailable-deadline-target-resolver';
import { UnavailableDeadlineTransactionManager } from './unavailable-deadline-transaction-manager';

describe('deadline unavailable adapters', () => {
  it('fails closed for repository reads that need DB adapter', async () => {
    const repository = new UnavailableDeadlineRepository();

    await expect(repository.listOrderDeadlines(42)).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: {
        feature: 'deadlines',
        adapter: 'deadline_repository',
      },
    } satisfies Partial<ApiError>);
  });

  it('keeps settings readable with safe defaults before DB adapter exists', async () => {
    await expect(new UnavailableDeadlineRepository().getSettings()).resolves.toMatchObject({
      notifyAssigneeEnabled: false,
      changeOrderStatusEnabled: false,
    });
  });

  it('fails closed for transactions, target resolution, and notifications', async () => {
    await expect(
      new UnavailableDeadlineTransactionManager().runInTransaction(async () => 'unreachable'),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    } satisfies Partial<ApiError>);

    await expect(
      new UnavailableDeadlineTargetResolver().resolveTargetState({
        entityType: 'order',
        entityId: '42',
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    } satisfies Partial<ApiError>);

    await expect(new UnavailableDeadlineNotificationPort().createNotification()).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    } satisfies Partial<ApiError>);
  });
});
