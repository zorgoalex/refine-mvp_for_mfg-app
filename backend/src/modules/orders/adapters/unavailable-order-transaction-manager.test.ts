import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import { UnavailableOrderTransactionManager } from './unavailable-order-transaction-manager';

describe('UnavailableOrderTransactionManager', () => {
  it('fails closed if orders writes are accidentally enabled before DB adapter exists', async () => {
    await expect(
      new UnavailableOrderTransactionManager().runInTransaction(async () => 'unreachable'),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        module: 'orders',
      },
    } satisfies Partial<ApiError>);
  });
});
