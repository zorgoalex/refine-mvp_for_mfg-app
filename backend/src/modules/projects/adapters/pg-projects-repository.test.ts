import { describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgProjectsRepository } from './pg-projects-repository';

describe('PgProjectsRepository.update', () => {
  it('locks the project row FOR UPDATE, writes exactly one audit row, and returns the updated dto', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 2,
        delete_flag: false,
      },
      updatedRow: {
        project_id: 5,
        code: 'ФК26',
        name: 'Новая кухня',
        client_id: 9,
        notes: null,
        version: 3,
      },
    });

    const result = await new PgProjectsRepository(database.service).update({
      currentUser: currentUser(),
      projectId: 5,
      dto: { code: 'ФК26', name: 'Новая кухня', notes: null },
      expectedVersion: 2,
      requestId: 'req-1',
    });

    expect(result).toMatchObject({
      projectId: 5,
      code: 'ФК26',
      name: 'Новая кухня',
      clientId: 9,
      notes: null,
      version: 3,
    });

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('FROM projects WHERE project_id = $1 FOR UPDATE');
    expect(sql).toContain('UPDATE projects SET');
    expect(database.queries.filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log (')).length).toBe(1);

    const audit = database.queries.find((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log'));
    expect(audit).toBeDefined();
    expect(audit?.params[0]).toBe('project.updated');
    expect(audit?.params[1]).toBe('project');
    expect(audit?.params[2]).toBe('5');
    expect(audit?.params[9]).toBe(9);
    expect(audit?.params[22]).toContain('"projectId":5');
    expect(audit?.params[22]).toContain('"action":"project_update"');
  });

  it('maps stale version to 409 VERSION_CONFLICT before update', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 3,
        delete_flag: false,
      },
    });

    await expect(
      new PgProjectsRepository(database.service).update({
        currentUser: currentUser(),
        projectId: 5,
        dto: { code: 'ФК26' },
        expectedVersion: 2,
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE projects SET');
    expect(sql).not.toContain('INSERT INTO audit_log');
  });

  it('maps unique violation 23505 to 409 PROJECT_CODE_TAKEN', async () => {
    const database = createDatabase({
      beforeRow: {
        project_id: 5,
        code: 'ФК25',
        name: 'Старая кухня',
        client_id: 9,
        notes: 'old',
        version: 2,
        delete_flag: false,
      },
      throwOnUpdate: { code: '23505' },
    });

    await expect(
      new PgProjectsRepository(database.service).update({
        currentUser: currentUser(),
        projectId: 5,
        dto: { code: 'ФК26' },
        expectedVersion: 2,
        requestId: 'req-1',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'PROJECT_CODE_TAKEN' });

    expect(normalizedSql(database.queries)).not.toContain('INSERT INTO audit_log');
  });
});

describe('PgProjectsRepository.moveOrder', () => {
  it('moves order, bumps order version, archives emptied source with own audit event', async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 0,
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-1',
      requestId: 'req-move-1',
    });

    expect(result).toMatchObject({
      orderId: 10,
      projectId: 200,
      code: 'ФК26',
      archivedSourceProjectId: 100,
      requestId: 'req-move-1',
    });
    expect(result.auditId).toBeTypeOf('string');

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('command_name, actor_user_id, entity_type, entity_id, request_hash, status');
    expect(sql).toContain('FROM orders o WHERE o.order_id = $1 AND o.delete_flag = false FOR UPDATE');
    expect(sql).toContain('UPDATE orders SET project_id = $2, version = version + 1');
    expect(sql).toContain('SELECT COUNT(*) AS c FROM orders WHERE project_id = $1');
    expect(sql).toContain('UPDATE projects SET delete_flag = true, version = version + 1');
    expect(sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(sql).toContain("UPDATE command_idempotency_keys SET status = 'completed'");

    const auditEvents = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('))
      .map((query) => query.params[0]);
    expect(auditEvents).toEqual(['project.archived', 'project.order_moved']);

    const outboxKeys = database.outboxRows.map((row) => row.idempotencyKey);
    expect(outboxKeys).toEqual(['move-order-key-1:archived', 'move-order-key-1']);
    expect(database.outboxRows.map((row) => row.eventType)).toEqual(['project.archived', 'project.order_moved']);
  });

  it('soft-deleted order → 404, source with remaining deleted orders NOT archived', async () => {
    const missingOrderDb = createDatabase({
      lockedOrderRow: null,
    });

    await expect(
      new PgProjectsRepository(missingOrderDb.service).moveOrder({
        currentUser: currentUser(),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-404',
        requestId: 'req-move-404',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });

    expect(normalizedSql(missingOrderDb.queries)).not.toContain('UPDATE orders SET project_id = $2');

    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 1,
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-remaining',
      requestId: 'req-move-remaining',
    });

    expect(result.archivedSourceProjectId).toBeNull();
    expect(database.queries.map((query) => normalizeSql(query.text)).join('\n')).not.toContain(
      'UPDATE projects SET delete_flag = true, version = version + 1',
    );
    expect(database.outboxRows.map((row) => row.eventType)).toEqual(['project.order_moved']);
  });

  it('createNew=true mints МП-N root and moves there', async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      sourceOrderCount: 1,
      autoRootRow: {
        project_id: 301,
        code: 'МП-301',
      },
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      createNew: true,
      idempotencyKey: 'move-order-key-new-root',
      requestId: 'req-move-root',
    });

    expect(result).toMatchObject({
      orderId: 10,
      projectId: 301,
      code: 'МП-301',
      archivedSourceProjectId: null,
    });

    const auditEvents = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('))
      .map((query) => query.params[0]);
    expect(auditEvents).toEqual(['project.created', 'project.order_moved']);
    expect(database.outboxRows.map((row) => row.idempotencyKey)).toEqual(['project.created:301', 'move-order-key-new-root']);
    expect(normalizedSql(database.queries)).toContain("WITH next_project AS ( SELECT nextval(pg_get_serial_sequence('public.projects', 'project_id')) AS project_id )");
  });

  it('client mismatch → 422; replay with same idempotency key returns cached response without second UPDATE', async () => {
    const mismatchDb = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 9,
        delete_flag: false,
        code: 'ФК26',
      },
    });

    await expect(
      new PgProjectsRepository(mismatchDb.service).moveOrder({
        currentUser: currentUser(),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-mismatch',
        requestId: 'req-move-mismatch',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'PROJECT_CLIENT_MISMATCH' });

    expect(normalizedSql(mismatchDb.queries)).not.toContain('UPDATE orders SET project_id = $2, version = version + 1');

    const replayDb = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 1,
    });

    const repo = new PgProjectsRepository(replayDb.service);
    const command = {
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-replay',
      requestId: 'req-move-replay',
    };

    const first = await repo.moveOrder(command);
    const second = await repo.moveOrder(command);

    expect(second).toEqual(first);
    expect(
      replayDb.queries.filter((query) =>
        normalizeSql(query.text).startsWith('UPDATE orders SET project_id = $2, version = version + 1'),
      ),
    ).toHaveLength(1);
  });

  it("manager ('own' scope) moving someone else's order → 403, no writes", async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '999',
        manager_id: '999',
      },
    });

    await expect(
      new PgProjectsRepository(database.service).moveOrder({
        currentUser: currentUser('manager'),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-foreign',
        requestId: 'req-move-foreign',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET project_id');
    expect(sql).not.toContain('INSERT INTO audit_log');
  });

  it("admin ('all' scope) can move someone else's order", async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '999',
        manager_id: '999',
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
      sourceOrderCount: 1,
    });

    const result = await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser('admin'),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-admin',
      requestId: 'req-move-admin',
    });
    expect(result.projectId).toBe(200);
  });

  it('locks source project row (with target, ascending) before the archive decision', async () => {
    const database = createDatabase({
      sourceOrderCount: 0,
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
    });

    await new PgProjectsRepository(database.service).moveOrder({
      currentUser: currentUser(),
      orderId: 10,
      targetProjectId: 200,
      idempotencyKey: 'move-order-key-lock-source',
      requestId: 'req-move-lock',
    });

    // Source project 100 must be locked, and lock order must be ascending ids.
    expect(lockQueryIds(database.queries)).toEqual([100, 200]);

    // Global anti-deadlock order shared with merge: ALL project locks must be
    // taken before the order row lock.
    const normalized = database.queries.map((query) => normalizeSql(query.text));
    const lastProjectLockIdx = normalized.reduce(
      (last, sql, idx) =>
        sql.startsWith('SELECT project_id, client_id, delete_flag, code FROM projects WHERE project_id = $1 FOR UPDATE') ? idx : last,
      -1,
    );
    const orderLockIdx = normalized.findIndex((sql) =>
      sql.startsWith('SELECT o.order_id, o.order_name, o.client_id, o.project_id, o.created_by, o.manager_id FROM orders o'),
    );
    expect(lastProjectLockIdx).toBeGreaterThanOrEqual(0);
    expect(orderLockIdx).toBeGreaterThan(lastProjectLockIdx);
  });

  it("foreign order + target == its current project → 403, not 422 (no project-membership probe)", async () => {
    const database = createDatabase({
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '999',
        manager_id: '999',
      },
    });

    await expect(
      new PgProjectsRepository(database.service).moveOrder({
        currentUser: currentUser('manager'),
        orderId: 10,
        targetProjectId: 100,
        idempotencyKey: 'move-order-key-probe',
        requestId: 'req-move-probe',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('409 (not stale 422) when target equals the pre-read project but the locked row moved on', async () => {
    const database = createDatabase({
      preReadProjectId: 200,
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
    });

    await expect(
      new PgProjectsRepository(database.service).moveOrder({
        currentUser: currentUser(),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-stale-same',
        requestId: 'req-move-stale-same',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_PROJECT_CONFLICT' });
  });

  it('409 when the order was re-parented between the unlocked pre-read and the row lock', async () => {
    const database = createDatabase({
      preReadProjectId: 150,
      lockedOrderRow: {
        order_id: 10,
        order_name: '1258',
        client_id: 2,
        project_id: 100,
        created_by: '7',
        manager_id: null,
      },
      targetProjectRow: {
        project_id: 200,
        client_id: 2,
        delete_flag: false,
        code: 'ФК26',
      },
    });

    await expect(
      new PgProjectsRepository(database.service).moveOrder({
        currentUser: currentUser(),
        orderId: 10,
        targetProjectId: 200,
        idempotencyKey: 'move-order-key-conflict',
        requestId: 'req-move-conflict',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ORDER_PROJECT_CONFLICT' });

    expect(normalizedSql(database.queries)).not.toContain('UPDATE orders SET project_id');
  });
});

describe('PgProjectsRepository.merge', () => {
  it('moves live source orders to target, archives source, writes two audits and two outbox rows', async () => {
    const database = createDatabase({
      projectRowsById: {
        100: {
          project_id: 100,
          client_id: 2,
          delete_flag: false,
          code: 'ФК26',
        },
        200: {
          project_id: 200,
          client_id: 2,
          delete_flag: false,
          code: 'ФК27',
        },
      },
      mergeMovedOrdersCount: 3,
      remainingDeletedOrders: 2,
    });

    const result = await new PgProjectsRepository(database.service).merge({
      currentUser: currentUser(),
      targetProjectId: 200,
      sourceProjectId: 100,
      idempotencyKey: 'merge-project-key-1',
      requestId: 'req-merge-1',
    });

    expect(result).toMatchObject({
      targetProjectId: 200,
      sourceProjectId: 100,
      movedOrdersCount: 3,
      requestId: 'req-merge-1',
    });
    expect(result.auditId).toBeTypeOf('string');

    const sql = normalizedSql(database.queries);
    expect(sql).toContain('SELECT set_session_user($1)');
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('FROM projects WHERE project_id = $1 FOR UPDATE');
    expect(sql).toContain('UPDATE orders SET project_id = $1, version = version + 1, edited_by = $3, updated_at = now() WHERE project_id = $2 AND delete_flag = false');
    expect(sql).toContain('SELECT COUNT(*) AS c FROM orders WHERE project_id = $1 AND delete_flag = true');
    expect(sql).toContain('UPDATE projects SET delete_flag = true, version = version + 1, edited_by = $2, updated_at = now() WHERE project_id = $1');

    const auditEvents = database.queries
      .filter((query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log ('))
      .map((query) => query.params[0]);
    expect(auditEvents).toEqual(['project.merged', 'project.archived']);

    const mergeAudit = database.queries.find(
      (query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log (') && query.params[0] === 'project.merged',
    );
    expect(mergeAudit?.params[2]).toBe('200');
    expect(mergeAudit?.params[9]).toBe(2);
    expect(mergeAudit?.params[22]).toContain('"sourceProjectId":100');
    expect(mergeAudit?.params[22]).toContain('"targetProjectId":200');
    expect(mergeAudit?.params[22]).toContain('"movedOrdersCount":3');
    expect(mergeAudit?.params[22]).toContain('"remainingDeletedOrders":2');
    expect(mergeAudit?.params[22]).toContain('"action":"project_merge"');

    const archivedAudit = database.queries.find(
      (query) => normalizeSql(query.text).startsWith('INSERT INTO audit_log (') && query.params[0] === 'project.archived',
    );
    expect(archivedAudit?.params[2]).toBe('100');
    expect(archivedAudit?.params[22]).toContain('"reason":"merged_into"');
    expect(archivedAudit?.params[22]).toContain('"targetProjectId":200');
    expect(archivedAudit?.params[22]).toContain('"action":"project_archive"');

    expect(database.outboxRows.map((row) => row.idempotencyKey)).toEqual([
      'merge-project-key-1',
      'merge-project-key-1:archived',
    ]);
    expect(database.outboxRows.map((row) => row.eventType)).toEqual(['project.merged', 'project.archived']);
  });

  it('locks projects in ascending id order regardless of source/target order', async () => {
    const lowerToHigherDb = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
        200: { project_id: 200, client_id: 2, delete_flag: false, code: 'ФК27' },
      },
      mergeMovedOrdersCount: 1,
      remainingDeletedOrders: 0,
    });
    await new PgProjectsRepository(lowerToHigherDb.service).merge({
      currentUser: currentUser(),
      targetProjectId: 200,
      sourceProjectId: 100,
      idempotencyKey: 'merge-project-key-asc-1',
      requestId: 'req-merge-asc-1',
    });

    const higherToLowerDb = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
        200: { project_id: 200, client_id: 2, delete_flag: false, code: 'ФК27' },
      },
      mergeMovedOrdersCount: 1,
      remainingDeletedOrders: 0,
    });
    await new PgProjectsRepository(higherToLowerDb.service).merge({
      currentUser: currentUser(),
      targetProjectId: 100,
      sourceProjectId: 200,
      idempotencyKey: 'merge-project-key-asc-2',
      requestId: 'req-merge-asc-2',
    });

    expect(lockQueryIds(lowerToHigherDb.queries)).toEqual([100, 200]);
    expect(lockQueryIds(higherToLowerDb.queries)).toEqual([100, 200]);
  });

  it('maps client mismatch and self-merge to 422; replay returns cached response without second UPDATE', async () => {
    const mismatchDb = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
        200: { project_id: 200, client_id: 9, delete_flag: false, code: 'ФК27' },
      },
    });

    await expect(
      new PgProjectsRepository(mismatchDb.service).merge({
        currentUser: currentUser(),
        targetProjectId: 200,
        sourceProjectId: 100,
        idempotencyKey: 'merge-project-key-mismatch',
        requestId: 'req-merge-mismatch',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'PROJECT_CLIENT_MISMATCH' });
    expect(normalizedSql(mismatchDb.queries)).not.toContain(
      'UPDATE orders SET project_id = $1, version = version + 1, edited_by = $3, updated_at = now() WHERE project_id = $2 AND delete_flag = false',
    );

    const sameDb = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
      },
    });
    await expect(
      new PgProjectsRepository(sameDb.service).merge({
        currentUser: currentUser(),
        targetProjectId: 100,
        sourceProjectId: 100,
        idempotencyKey: 'merge-project-key-same',
        requestId: 'req-merge-same',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'PROJECT_SAME' });

    const replayDb = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
        200: { project_id: 200, client_id: 2, delete_flag: false, code: 'ФК27' },
      },
      mergeMovedOrdersCount: 4,
      remainingDeletedOrders: 1,
    });
    const repo = new PgProjectsRepository(replayDb.service);
    const command = {
      currentUser: currentUser(),
      targetProjectId: 200,
      sourceProjectId: 100,
      idempotencyKey: 'merge-project-key-replay',
      requestId: 'req-merge-replay',
    };

    const first = await repo.merge(command);
    const second = await repo.merge(command);

    expect(second).toEqual(first);
    expect(
      replayDb.queries.filter((query) =>
        normalizeSql(query.text).startsWith(
          'UPDATE orders SET project_id = $1, version = version + 1, edited_by = $3, updated_at = now() WHERE project_id = $2 AND delete_flag = false',
        ),
      ),
    ).toHaveLength(1);
  });

  it("manager ('own' scope) merging a project holding someone else's live order → 403, no writes", async () => {
    const database = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
        200: { project_id: 200, client_id: 2, delete_flag: false, code: 'ФК27' },
      },
      sourceOrderRows: [
        { order_id: 11, order_name: '1259', client_id: 2, project_id: 100, created_by: '7', manager_id: null },
        { order_id: 12, order_name: '1260', client_id: 2, project_id: 100, created_by: '999', manager_id: '999' },
      ],
    });

    await expect(
      new PgProjectsRepository(database.service).merge({
        currentUser: currentUser('manager'),
        targetProjectId: 200,
        sourceProjectId: 100,
        idempotencyKey: 'merge-project-key-foreign',
        requestId: 'req-merge-foreign',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    const sql = normalizedSql(database.queries);
    expect(sql).not.toContain('UPDATE orders SET project_id');
    expect(sql).not.toContain('UPDATE projects SET delete_flag = true');
    expect(sql).not.toContain('INSERT INTO audit_log');
  });

  it('locks live source orders FOR UPDATE before moving them', async () => {
    const database = createDatabase({
      projectRowsById: {
        100: { project_id: 100, client_id: 2, delete_flag: false, code: 'ФК26' },
        200: { project_id: 200, client_id: 2, delete_flag: false, code: 'ФК27' },
      },
      mergeMovedOrdersCount: 1,
    });

    await new PgProjectsRepository(database.service).merge({
      currentUser: currentUser(),
      targetProjectId: 200,
      sourceProjectId: 100,
      idempotencyKey: 'merge-project-key-locks',
      requestId: 'req-merge-locks',
    });

    expect(normalizedSql(database.queries)).toContain(
      'SELECT order_id, order_name, client_id, project_id, created_by, manager_id FROM orders WHERE project_id = $1 AND delete_flag = false ORDER BY order_id FOR UPDATE',
    );
  });
});

function createDatabase(
  options: {
    beforeRow?: Record<string, unknown>;
    updatedRow?: Record<string, unknown>;
    throwOnUpdate?: { code: string };
    lockedOrderRow?: Record<string, unknown> | null;
    preReadProjectId?: number;
    targetProjectRow?: Record<string, unknown> | null;
    sourceOrderRows?: Array<Record<string, unknown>>;
    sourceOrderCount?: number;
    autoRootRow?: Record<string, unknown>;
    projectRowsById?: Record<number, Record<string, unknown> | null>;
    mergeMovedOrdersCount?: number;
    remainingDeletedOrders?: number;
  } = {},
) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const outboxRows: Array<{ eventType: string; aggregateId: string; payload: unknown; idempotencyKey: string }> = [];
  const idempotency = new Map<
    string,
    {
      requestHash: string;
      status: 'processing' | 'completed' | 'failed';
      responseJson: unknown;
    }
  >();
  let auditId = 100;
  const tx = {
    raw: {} as never,
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      const normalized = normalizeSql(text);

      if (normalized.startsWith('SELECT project_id, code, name, client_id, notes, version, delete_flag FROM projects')) {
        return { rows: options.beforeRow ? [options.beforeRow] : [], rowCount: options.beforeRow ? 1 : 0 };
      }

      if (normalized.startsWith('UPDATE projects SET')) {
        if (options.throwOnUpdate) {
          throw options.throwOnUpdate;
        }
        return { rows: options.updatedRow ? [options.updatedRow] : [], rowCount: options.updatedRow ? 1 : 0 };
      }

      if (normalized.startsWith('INSERT INTO command_idempotency_keys')) {
        const key = String(params[0]);
        const requestHash = String(params[5]);
        if (idempotency.has(key)) {
          return { rows: [], rowCount: 0 };
        }
        idempotency.set(key, {
          requestHash,
          status: 'processing',
          responseJson: null,
        });
        return {
          rows: [{ idempotency_key: key, request_hash: requestHash, response_json: null, status: 'processing' }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('SELECT idempotency_key, request_hash, response_json, status FROM command_idempotency_keys')) {
        const key = String(params[0]);
        const row = idempotency.get(key);
        return {
          rows: row
            ? [{
                idempotency_key: key,
                request_hash: row.requestHash,
                response_json: row.responseJson,
                status: row.status,
              }]
            : [],
          rowCount: row ? 1 : 0,
        };
      }

      if (normalized.startsWith("UPDATE command_idempotency_keys SET status = 'completed'")) {
        const key = String(params[0]);
        const row = idempotency.get(key);
        if (row) {
          row.status = 'completed';
          row.responseJson = JSON.parse(String(params[1]));
        }
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT project_id FROM orders WHERE order_id = $1 AND delete_flag = false')) {
        if (options.lockedOrderRow === null) {
          return { rows: [], rowCount: 0 };
        }
        const projectId = options.preReadProjectId ?? (options.lockedOrderRow ?? { project_id: 100 }).project_id;
        return { rows: [{ project_id: projectId }], rowCount: 1 };
      }

      if (
        normalized.startsWith(
          'SELECT o.order_id, o.order_name, o.client_id, o.project_id, o.created_by, o.manager_id FROM orders o WHERE o.order_id = $1 AND o.delete_flag = false FOR UPDATE',
        )
      ) {
        return {
          rows: options.lockedOrderRow === null ? [] : [options.lockedOrderRow ?? {
            order_id: 10,
            order_name: '1258',
            client_id: 2,
            project_id: 100,
            created_by: '7',
            manager_id: null,
          }],
          rowCount: options.lockedOrderRow === null ? 0 : 1,
        };
      }

      if (
        normalized.startsWith(
          'SELECT order_id, order_name, client_id, project_id, created_by, manager_id FROM orders WHERE project_id = $1 AND delete_flag = false ORDER BY order_id FOR UPDATE',
        )
      ) {
        const rows = options.sourceOrderRows ?? [
          { order_id: 11, order_name: '1259', client_id: 2, project_id: Number(params[0]), created_by: '7', manager_id: null },
        ];
        return { rows, rowCount: rows.length };
      }

      if (
        normalized.startsWith('SELECT project_id, client_id, delete_flag, code FROM projects WHERE project_id = $1 FOR UPDATE')
      ) {
        const projectId = Number(params[0]);
        const mappedRow = options.projectRowsById?.[projectId];
        return {
          rows: mappedRow === null ? [] : [mappedRow ?? options.targetProjectRow ?? {
            project_id: 200,
            client_id: 2,
            delete_flag: false,
            code: 'ФК26',
          }],
          rowCount: mappedRow === null || options.targetProjectRow === null ? 0 : 1,
        };
      }

      if (
        normalized.startsWith(
          "WITH next_project AS ( SELECT nextval(pg_get_serial_sequence('public.projects', 'project_id')) AS project_id ) INSERT INTO projects",
        )
      ) {
        return {
          rows: [options.autoRootRow ?? { project_id: 301, code: 'МП-301' }],
          rowCount: 1,
        };
      }

      if (normalized.startsWith('UPDATE orders SET project_id = $2, version = version + 1')) {
        return { rows: [], rowCount: 1 };
      }

      if (normalized.startsWith('UPDATE orders SET project_id = $1, version = version + 1')) {
        return { rows: [], rowCount: options.mergeMovedOrdersCount ?? 0 };
      }

      if (normalized.startsWith('SELECT COUNT(*) AS c FROM orders WHERE project_id = $1 AND delete_flag = true')) {
        return { rows: [{ c: String(options.remainingDeletedOrders ?? 0) }], rowCount: 1 };
      }

      if (normalized.startsWith('SELECT COUNT(*) AS c FROM orders WHERE project_id = $1')) {
        return { rows: [{ c: String(options.sourceOrderCount ?? 0) }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO audit_log')) {
        auditId += 1;
        return { rows: [{ audit_id: String(auditId) }], rowCount: 1 };
      }

      if (normalized.startsWith('INSERT INTO outbox_events')) {
        const eventType = String(params[0]);
        const usesLiteralAggregateType = typeof params[1] === 'string' && typeof params[2] === 'string' && String(params[2]).startsWith('{');
        const aggregateId = String(usesLiteralAggregateType ? params[1] : params[2]);
        const payloadParam = usesLiteralAggregateType ? params[2] : params[3];
        const payload = typeof payloadParam === 'string' ? JSON.parse(payloadParam) : payloadParam;
        const idempotencyKey = String(usesLiteralAggregateType ? params[3] : params[4]);
        if (!outboxRows.some((row) => row.idempotencyKey === idempotencyKey)) {
          outboxRows.push({ eventType, aggregateId, payload, idempotencyKey });
        }
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    },
  };

  return {
    queries,
    outboxRows,
    service: {
      async transaction<T>(handler: (client: typeof tx) => Promise<T>) {
        return handler(tx);
      },
    } as unknown as DatabaseService,
  };
}

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return {
    id: '7',
    username: role,
    role,
    roleId: 10,
    permissions: getPermissionsForRole(role),
  };
}

function normalizedSql(queries: Array<{ text: string }>): string {
  return queries.map((query) => normalizeSql(query.text)).join('\n');
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function lockQueryIds(queries: Array<{ text: string; params: readonly unknown[] }>): number[] {
  return queries
    .filter((query) => normalizeSql(query.text).startsWith('SELECT project_id, client_id, delete_flag, code FROM projects WHERE project_id = $1 FOR UPDATE'))
    .map((query) => Number(query.params[0]));
}
