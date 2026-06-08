import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ApiError } from '../../../common/errors/api-error';
import { PgNotificationRuleRepository } from './pg-notification-rule-repository';

const databaseUrl = process.env.NOTIFICATION_ENGINE_INTEGRATION_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

maybe('PgNotificationRuleRepository integration', () => {
  const schemaName = `notification_rules_${randomUUID().replaceAll('-', '_')}`;
  let pool: Pool;
  let repository: PgNotificationRuleRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}`);
    await applyMigration(pool);
    repository = new PgNotificationRuleRepository();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('supports create, list, update with optimistic concurrency, getById and delete', async () => {
    const ruleCode = `E2E-rule-${randomUUID()}`;
    const eventType = 'order.status_changed';

    const created = await repository.create(pool, {
      ruleCode,
      eventType,
      level: 'info',
      priority: 100,
      isEnabled: true,
      conditions: { allowedFromOrderStatusIds: [1, 2] },
      recipients: { resolvers: ['order_manager'] },
      titleTemplate: 'Order {{orderId}} changed',
      messageTemplate: 'Status changed to {{status}}',
      createdByUserId: 1,
    });

    expect(created.ruleCode).toBe(ruleCode);
    expect(created.eventType).toBe(eventType);
    expect(created.level).toBe('info');
    expect(created.isEnabled).toBe(true);
    expect(created.conditions).toEqual({ allowedFromOrderStatusIds: [1, 2] });
    expect(created.recipients).toEqual({ resolvers: ['order_manager'] });
    expect(typeof created.createdAt).toBe('string');
    expect(typeof created.updatedAt).toBe('string');

    const enabledByEvent = await repository.listEnabledByEvent(pool, eventType);
    expect(enabledByEvent.some((rule) => rule.notificationRuleId === created.notificationRuleId)).toBe(true);

    const updated = await repository.update(pool, created.notificationRuleId, {
      level: 'warning',
      priority: 50,
      isEnabled: false,
      conditions: { allowedFromOrderStatusIds: [3] },
      recipients: { roleCodes: ['manager'] },
      titleTemplate: 'Updated title',
      messageTemplate: 'Updated message',
      updatedByUserId: 2,
      expectedUpdatedAt: created.updatedAt,
    });

    expect(updated.level).toBe('warning');
    expect(updated.priority).toBe(50);
    expect(updated.isEnabled).toBe(false);
    expect(updated.conditions).toEqual({ allowedFromOrderStatusIds: [3] });
    expect(updated.recipients).toEqual({ roleCodes: ['manager'] });
    expect(updated.titleTemplate).toBe('Updated title');
    expect(updated.messageTemplate).toBe('Updated message');

    await expect(
      repository.update(pool, created.notificationRuleId, {
        priority: 10,
        updatedByUserId: 2,
        expectedUpdatedAt: created.updatedAt,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOTIFICATION_RULE_STALE',
    });
    await expect(
      repository.update(pool, created.notificationRuleId, {
        priority: 10,
        updatedByUserId: 2,
        expectedUpdatedAt: created.updatedAt,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const fetched = await repository.getById(pool, created.notificationRuleId);
    expect(fetched?.notificationRuleId).toBe(created.notificationRuleId);
    expect(fetched?.priority).toBe(50);

    const listed = await repository.list(pool, { eventType });
    expect(listed.some((rule) => rule.notificationRuleId === created.notificationRuleId)).toBe(true);

    const deleted = await repository.delete(pool, created.notificationRuleId);
    expect(deleted?.notificationRuleId).toBe(created.notificationRuleId);

    const afterDelete = await repository.getById(pool, created.notificationRuleId);
    expect(afterDelete).toBeNull();
  });
});

async function applyMigration(pool: Pool): Promise<void> {
  const migrationPath = resolve(__dirname, '../../../../db/migrations/014_notification_rules.sql');
  const sql = readFileSync(migrationPath, 'utf8');
  await pool.query(sql);
}
