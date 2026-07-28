import { describe, expect, it } from 'vitest';
import { PgNotificationChannelDeliveryAdapter } from './pg-notification-channel-delivery';

const input = {
  notificationRuleId: '00000000-0000-0000-0000-000000000001',
  outboxEventId: '00000000-0000-0000-0000-000000000002',
  userId: 7,
  channel: 'telegram' as const,
  level: 'warning' as const,
  title: 'Срок',
  message: 'Заказ просрочен',
  entityType: 'order',
  entityId: '42',
  sourceType: 'notification_rule',
  sourceId: '00000000-0000-0000-0000-000000000001',
  idempotencyKey: 'delivery-key',
};

describe('PgNotificationChannelDeliveryAdapter', () => {
  it('enqueues one external delivery and returns its id', async () => {
    const queries: Array<{ text: string; params?: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, params?: readonly unknown[]) => {
        queries.push({ text, params });
        return {
          rows: [{ notification_channel_delivery_id: 'delivery-1' }],
          rowCount: 1,
        };
      },
    };

    await expect(
      new PgNotificationChannelDeliveryAdapter().enqueueIfAbsent(client as never, input),
    ).resolves.toEqual({ created: true, deliveryId: 'delivery-1' });

    expect(queries[0]?.text).toContain('INSERT INTO notification_channel_deliveries');
    expect(queries[0]?.text).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(queries[0]?.params).toContain('telegram');
  });

  it('returns existing delivery on idempotent replay', async () => {
    let call = 0;
    const client = {
      query: async () => {
        call += 1;
        return call === 1
          ? { rows: [], rowCount: 0 }
          : { rows: [{ notification_channel_delivery_id: 'delivery-existing' }], rowCount: 1 };
      },
    };

    await expect(
      new PgNotificationChannelDeliveryAdapter().enqueueIfAbsent(client as never, input),
    ).resolves.toEqual({ created: false, deliveryId: 'delivery-existing' });
  });
});
