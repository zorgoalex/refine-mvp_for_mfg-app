import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import { PgRecipientSourceAdapter } from './pg-recipient-source';
import { PgVisibilityAdapter } from './pg-visibility';

const databaseUrl = process.env.NOTIFICATION_ENGINE_INTEGRATION_DATABASE_URL;
const maybe = databaseUrl ? describe : describe.skip;

function buildContext(overrides: Partial<NotificationEventContext>): NotificationEventContext {
  return {
    eventType: 'order.status_changed',
    outboxEventId: randomUUID(),
    aggregateType: 'order',
    aggregateId: '1',
    orderId: null,
    clientId: null,
    paymentId: null,
    deadlineId: null,
    deadlineEntityType: null,
    deadlineInstanceId: null,
    groupIds: [],
    orderStatusId: null,
    isOrderCompleted: false,
    isCurrentDeadlineEvent: true,
    payload: {},
    ...overrides,
  };
}

maybe('PgRecipientSourceAdapter / PgVisibilityAdapter integration', () => {
  const schemaName = `notification_recipient_source_${randomUUID().replaceAll('-', '_')}`;
  let pool: Pool;
  let recipientSource: PgRecipientSourceAdapter;
  let visibility: PgVisibilityAdapter;

  let managerUserId: number;
  let viewerUserId: number;
  let workerUserId: number;
  let outsiderUserId: number;
  let inactiveUserId: number;
  let orderId: number;
  let projectParticipantUserId: number;
  let deadlineLinkedParticipantUserId: number;
  let orderProjectId: string;
  let deadlineProjectId: string;
  const deadlineInstanceId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`CREATE SCHEMA ${schemaName}`);
    await pool.query(`SET search_path TO ${schemaName}`);
    await createMinimalSchema(pool);
    recipientSource = new PgRecipientSourceAdapter();
    visibility = new PgVisibilityAdapter();

    const userRows = await pool.query<{ user_id: number }>(
      `
      INSERT INTO users (username, role_id, employee_id, is_active)
      VALUES
        ('E2E-manager', 10, 901, true),
        ('E2E-viewer', 100, NULL, true),
        ('E2E-worker', 20, 902, true),
        ('E2E-outsider', 20, NULL, true),
        ('E2E-inactive', 10, NULL, false)
      RETURNING user_id
      `,
    );
    [managerUserId, viewerUserId, workerUserId, outsiderUserId, inactiveUserId] = userRows.rows.map((r) => Number(r.user_id));

    const orderRows = await pool.query<{ order_id: number }>(
      `
      INSERT INTO orders (order_name, manager_id, created_by, delete_flag)
      VALUES ('E2E-order-1', $1::bigint, $1::bigint, false)
      RETURNING order_id
      `,
      [managerUserId],
    );
    orderId = Number(orderRows.rows[0].order_id);

    await pool.query(
      `
      INSERT INTO order_workshops (order_id, workshop_id, production_status_id, responsible_employee_id, delete_flag)
      VALUES ($1::bigint, 1, 1, 902, false)
      `,
      [orderId],
    );

    const projectRows = await pool.query<{ id: string }>(
      `INSERT INTO group_groups (name) VALUES ('E2E-project-1') RETURNING id`,
    );
    orderProjectId = projectRows.rows[0].id;

    await pool.query(
      `INSERT INTO group_order_groups (order_id, group_id, relation_type, is_primary, valid_from, valid_to)
       VALUES ($1::bigint, $2::uuid, 'primary', true, now(), NULL)`,
      [orderId, orderProjectId],
    );

    const participantRows = await pool.query<{ user_id: number }>(
      `
      INSERT INTO users (username, role_id, employee_id, is_active)
      VALUES ('E2E-participant', 100, NULL, true)
      RETURNING user_id
      `,
    );
    projectParticipantUserId = Number(participantRows.rows[0].user_id);

    await pool.query(
      `INSERT INTO group_participants (group_id, participant_type, participant_id_text, role_code, valid_from, valid_to)
       VALUES ($1::uuid, 'user', $2::text, 'member', now(), NULL)`,
      [orderProjectId, String(projectParticipantUserId)],
    );

    // Second project linked to the deadline ONLY via a generic deadline-instance
    // entity link (NOT via the order) — proves the P8 convergence parity fix:
    // the engine must reach these participants too.
    const deadlineProjectRows = await pool.query<{ id: string }>(
      `INSERT INTO group_groups (name) VALUES ('E2E-project-deadline-only') RETURNING id`,
    );
    deadlineProjectId = deadlineProjectRows.rows[0].id;

    await pool.query(
      `INSERT INTO group_entity_links (group_id, entity_type_code, entity_id_text, relation_type, valid_from, valid_to)
       VALUES ($1::uuid, 'deadline_instance', $2::text, 'related', now(), NULL)`,
      [deadlineProjectId, deadlineInstanceId],
    );

    const deadlineParticipantRows = await pool.query<{ user_id: number }>(
      `
      INSERT INTO users (username, role_id, employee_id, is_active)
      VALUES ('E2E-deadline-participant', 100, NULL, true)
      RETURNING user_id
      `,
    );
    deadlineLinkedParticipantUserId = Number(deadlineParticipantRows.rows[0].user_id);

    await pool.query(
      `INSERT INTO group_participants (group_id, participant_type, participant_id_text, role_code, valid_from, valid_to)
       VALUES ($1::uuid, 'user', $2::text, 'member', now(), NULL)`,
      [deadlineProjectId, String(deadlineLinkedParticipantUserId)],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await pool.end();
    }
  });

  it('resolves order_manager from orders.manager_id', async () => {
    const ctx = buildContext({ orderId });
    const result = await recipientSource.resolveDynamic(pool, 'order_manager', ctx);
    expect(result).toEqual([managerUserId]);
  });

  it('resolves stage_assignee via order_workshops.responsible_employee_id -> users', async () => {
    const ctx = buildContext({ orderId });
    const result = await recipientSource.resolveDynamic(pool, 'stage_assignee', ctx);
    expect(result).toEqual([workerUserId]);
  });

  it('resolves group_participants for typed user participants of projects linked to the order', async () => {
    const ctx = buildContext({ orderId, groupIds: [orderProjectId] });
    const result = await recipientSource.resolveDynamic(pool, 'group_participants', ctx);
    expect(result).toEqual([projectParticipantUserId]);
  });

  it('resolves group_participants only from effective deadline project attribution', async () => {
    const ctx = buildContext({ orderId, deadlineInstanceId, groupIds: [deadlineProjectId] });
    const result = await recipientSource.resolveDynamic(pool, 'group_participants', ctx);
    expect(result).toEqual([deadlineLinkedParticipantUserId]);
  });

  it('resolveRoleMembers returns active users for a role', async () => {
    const result = await recipientSource.resolveRoleMembers(pool, ['manager']);
    expect(result).toContain(managerUserId);
    expect(result).not.toContain(inactiveUserId);
  });

  it('filterActiveUsers drops inactive users', async () => {
    const result = await recipientSource.filterActiveUsers(pool, [managerUserId, inactiveUserId]);
    expect(result).toEqual([managerUserId]);
  });

  it('filterByBaseVisibility keeps a base-visible user and drops a non-visible user for the same order', async () => {
    // managerUserId (role 10 'own' scope) IS the order's manager_id/created_by -> base-visible.
    // outsiderUserId (role 20 'assigned' scope) is neither manager nor assigned to this order -> dropped.
    const ctx = buildContext({ orderId });
    const result = await visibility.filterByBaseVisibility(pool, [managerUserId, viewerUserId, outsiderUserId], ctx);
    expect(result).toContain(managerUserId);
    expect(result).not.toContain(outsiderUserId);
  });

  it('resolves workshop_head via order_workshops.workshop_id -> workshop_heads', async () => {
    const head = await pool.query<{ user_id: number }>(
      `INSERT INTO users (username, role_id, is_active) VALUES ('wh_head', 100, true) RETURNING user_id`,
    );
    const headUserId = head.rows[0].user_id;
    await pool.query(`INSERT INTO workshop_heads (workshop_id, user_id) VALUES (1, ${headUserId})`);

    const result = await recipientSource.resolveDynamic(pool as never, 'workshop_head', buildContext({ orderId }));
    expect(result).toContain(headUserId);
  });

  it('resolves direction_head via work-center membership of the order workshop', async () => {
    const wc = await pool.query<{ workcenter_id: number }>(
      `INSERT INTO work_centers (workshop_id, workcenter_name) VALUES (1, 'WC-1') RETURNING workcenter_id`,
    );
    const dir = await pool.query<{ direction_id: number }>(
      `INSERT INTO directions (direction_name) VALUES ('Фрезеровка') RETURNING direction_id`,
    );
    const dirHead = await pool.query<{ user_id: number }>(
      `INSERT INTO users (username, role_id, is_active) VALUES ('dir_head', 100, true) RETURNING user_id`,
    );
    const directionId = dir.rows[0].direction_id;
    const dirHeadUserId = dirHead.rows[0].user_id;
    await pool.query(`INSERT INTO direction_work_centers (direction_id, workcenter_id) VALUES (${directionId}, ${wc.rows[0].workcenter_id})`);
    await pool.query(`INSERT INTO direction_heads (direction_id, user_id) VALUES (${directionId}, ${dirHeadUserId})`);

    const result = await recipientSource.resolveDynamic(pool as never, 'direction_head', buildContext({ orderId }));
    expect(result).toContain(dirHeadUserId);
  });

  it('drops a resolved head who has no base visibility of the order (over-approximation bound)', async () => {
    // role 20 = 'assigned' scope (same as the existing outsider): neither manager
    // nor assigned to this order, so base visibility must drop them even though
    // the resolver returns them.
    const blind = await pool.query<{ user_id: number }>(
      `INSERT INTO users (username, role_id, is_active) VALUES ('wh_head_blind', 20, true) RETURNING user_id`,
    );
    const blindHeadUserId = blind.rows[0].user_id;
    await pool.query(`INSERT INTO workshop_heads (workshop_id, user_id) VALUES (1, ${blindHeadUserId})`);

    const resolved = await recipientSource.resolveDynamic(pool as never, 'workshop_head', buildContext({ orderId }));
    expect(resolved).toContain(blindHeadUserId);

    const visible = await visibility.filterByBaseVisibility(pool as never, resolved, buildContext({ orderId }));
    expect(visible).not.toContain(blindHeadUserId);
  });
});

async function createMinimalSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE users (
      user_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      username TEXT NOT NULL,
      role_id SMALLINT NOT NULL DEFAULT 100,
      employee_id BIGINT,
      is_active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE orders (
      order_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      order_name TEXT NOT NULL,
      manager_id BIGINT,
      created_by BIGINT NOT NULL,
      delete_flag BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE order_workshops (
      order_workshop_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES orders(order_id),
      workshop_id SMALLINT NOT NULL,
      production_status_id SMALLINT NOT NULL,
      responsible_employee_id BIGINT,
      delete_flag BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE group_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL
    );

    CREATE TABLE group_order_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id BIGINT NOT NULL REFERENCES orders(order_id),
      group_id UUID NOT NULL REFERENCES group_groups(id),
      relation_type TEXT NOT NULL DEFAULT 'primary',
      is_primary BOOLEAN NOT NULL DEFAULT false,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      valid_to TIMESTAMPTZ
    );

    CREATE TABLE group_participants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES group_groups(id),
      participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'employee')),
      participant_id_text TEXT NOT NULL,
      role_code TEXT NOT NULL,
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      valid_to TIMESTAMPTZ
    );

    CREATE TABLE group_entity_links (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES group_groups(id),
      entity_type_code TEXT NOT NULL,
      entity_id_text TEXT NOT NULL,
      relation_type TEXT NOT NULL DEFAULT 'related',
      valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
      valid_to TIMESTAMPTZ
    );

    CREATE TABLE work_centers (
      workcenter_id SMALLINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workshop_id SMALLINT NOT NULL,
      workcenter_name TEXT NOT NULL
    );

    CREATE TABLE directions (
      direction_id SMALLINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      direction_name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true
    );

    CREATE TABLE direction_workshops (
      direction_id SMALLINT NOT NULL REFERENCES directions(direction_id),
      workshop_id SMALLINT NOT NULL,
      PRIMARY KEY (direction_id, workshop_id)
    );

    CREATE TABLE direction_work_centers (
      direction_id SMALLINT NOT NULL REFERENCES directions(direction_id),
      workcenter_id SMALLINT NOT NULL REFERENCES work_centers(workcenter_id),
      PRIMARY KEY (direction_id, workcenter_id)
    );

    CREATE TABLE workshop_heads (
      workshop_id SMALLINT NOT NULL,
      user_id BIGINT NOT NULL REFERENCES users(user_id),
      is_active BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (workshop_id, user_id)
    );

    CREATE TABLE direction_heads (
      direction_id SMALLINT NOT NULL REFERENCES directions(direction_id),
      user_id BIGINT NOT NULL REFERENCES users(user_id),
      is_active BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (direction_id, user_id)
    );
  `);
}
