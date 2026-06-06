import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const canaryEnabled = process.env.DEADLINE_ORDER_SAVE_SYNC_STAGE_CANARY === 'true';
const fixtureKey = process.env.DEADLINE_ORDER_SAVE_SYNC_FIXTURE_KEY ?? '';
const expectedFixtureKey = 'deadline-enable-order-save-sync-2026-06-06';
const backendApiUrl = trimTrailingSlash(process.env.DEADLINE_ORDER_SAVE_SYNC_BACKEND_API_URL ?? '');
const postgresContainer = process.env.DEADLINE_ORDER_SAVE_SYNC_POSTGRES_CONTAINER ?? '';
const backendContainer = process.env.DEADLINE_ORDER_SAVE_SYNC_BACKEND_CONTAINER ?? '';
const fixtureOrderId = readNumberEnv('DEADLINE_ORDER_SAVE_SYNC_FIXTURE_ORDER_ID');
const enableCommand = process.env.DEADLINE_ORDER_SAVE_SYNC_ENABLE_COMMAND ?? '';
const disableCommand = process.env.DEADLINE_ORDER_SAVE_SYNC_DISABLE_COMMAND ?? '';
const plannedCompletionDate =
  process.env.DEADLINE_ORDER_SAVE_SYNC_PLANNED_COMPLETION_DATE ?? '2026-06-30';
const requestIdPrefix = `${expectedFixtureKey}:order-save-sync`;
const createRequestId = `${requestIdPrefix}:positive`;
const staleRequestId = `${requestIdPrefix}:stale`;
const disabledRequestId = `${requestIdPrefix}:disabled`;
const lockKey = `${expectedFixtureKey}:exclusive-live-window`;

const missingCanaryPrerequisites = [
  fixtureKey === expectedFixtureKey ? null : `DEADLINE_ORDER_SAVE_SYNC_FIXTURE_KEY=${expectedFixtureKey}`,
  process.env.DEADLINE_ORDER_SAVE_SYNC_RESTORE === 'true'
    ? null
    : 'DEADLINE_ORDER_SAVE_SYNC_RESTORE=true',
  process.env.DEADLINE_ORDER_SAVE_SYNC_TARGET_ENV === 'backend-test'
    ? null
    : 'DEADLINE_ORDER_SAVE_SYNC_TARGET_ENV=backend-test',
  process.env.COMPOSE_PROJECT_NAME === 'erp_test' ? null : 'COMPOSE_PROJECT_NAME=erp_test',
  backendApiUrl ? null : 'DEADLINE_ORDER_SAVE_SYNC_BACKEND_API_URL',
  postgresContainer ? null : 'DEADLINE_ORDER_SAVE_SYNC_POSTGRES_CONTAINER',
  backendContainer ? null : 'DEADLINE_ORDER_SAVE_SYNC_BACKEND_CONTAINER',
  fixtureOrderId ? null : 'DEADLINE_ORDER_SAVE_SYNC_FIXTURE_ORDER_ID',
  enableCommand.trim() ? null : 'DEADLINE_ORDER_SAVE_SYNC_ENABLE_COMMAND',
  disableCommand.trim() ? null : 'DEADLINE_ORDER_SAVE_SYNC_DISABLE_COMMAND',
  postgresContainer && dockerContainerExists(postgresContainer)
    ? null
    : `docker container ${postgresContainer}`,
  backendContainer && dockerContainerExists(backendContainer)
    ? null
    : `docker container ${backendContainer}`,
].filter((value): value is string => Boolean(value));

test.describe('deadline order-save sync stage canary', () => {
  test.skip(
    !canaryEnabled,
    'Set DEADLINE_ORDER_SAVE_SYNC_STAGE_CANARY=true to enable the live stage canary.',
  );
  test.skip(
    canaryEnabled && missingCanaryPrerequisites.length > 0,
    `Missing Deadline order-save sync canary prerequisites: ${missingCanaryPrerequisites.join(', ')}`,
  );
  test.setTimeout(360000);

  let userId: number | null = null;
  let snapshot: OrderSnapshot | null = null;
  let capturedDeadlineIds: string[] = [];

  test.beforeAll(() => {
    requireCanaryEnv();
    assertBackendTestApiUrl(backendApiUrl);
    assertNonProductionLikeContainer(postgresContainer, 'postgres');
    assertNonProductionLikeContainer(backendContainer, 'backend');

    expectNoActiveWindow();
    snapshot = loadOrderSnapshot();
    restoreOrder(snapshot);
    restoreFixtureRows();
    expectResidueEmpty(loadResidueCounts());
    expectNoStageDeadlineInputs();
    acquireExclusiveWindow();
  });

  test.afterAll(() => {
    let restoreError: unknown;
    try {
      runRuntimeCommand(disableCommand, 'disable order-save sync');
      expectBackendOrderSyncFlag(false);
      if (snapshot) {
        restoreOrder(snapshot);
      }
      releaseExclusiveWindow();
      restoreFixtureRows(capturedDeadlineIds);
      expectResidueEmpty(loadResidueCounts(capturedDeadlineIds));
    } catch (error) {
      restoreError = error;
    } finally {
      try {
        cleanupUser(userId);
      } catch (cleanupError) {
        if (!restoreError) throw cleanupError;
      }
      if (restoreError) throw restoreError;
    }
  });

  test('creates one final order deadline from backend order save, proves stale safety, and restores fail-closed', async ({
    request,
  }) => {
    const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const username = `e2e_deadline_order_sync_${runId}_${crypto.randomBytes(4).toString('hex')}`;
    const password = crypto.randomBytes(24).toString('base64url');

    userId = createSmokeUser(username, password);
    const token = await loginForApiToken(request, username, password);

    runRuntimeCommand(enableCommand, 'enable order-save sync');
    expectBackendOrderSyncFlag(true);

    const initial = await loadOrderForSave(request, token);
    const positivePayload = buildSavePayload(initial, {
      plannedCompletionDate,
      notesSuffix: `[${fixtureKey}:positive]`,
      idempotencyKey: `${requestIdPrefix}:idempotency:positive`,
    });
    const saved = await saveOrder(request, token, positivePayload, createRequestId);
    expect(saved.order.header.orderId).toBe(fixtureOrderId);

    const evidence = loadSyncEvidence(createRequestId);
    capturedDeadlineIds = evidence.deadlineIds;
    expect(evidence).toMatchObject({
      finalDeadlineCount: 1,
      stageDeadlineCount: 0,
      eventRows: 1,
      auditRows: 1,
      outboxRows: 1,
      orderOutboxRows: 1,
      auditRequestRows: 1,
      outboxRequestRows: 2,
    });
    expect(evidence.deadlineIds).toHaveLength(1);

    const staleResponse = await request.put(`${backendApiUrl}/orders/${fixtureOrderId}`, {
      data: positivePayload,
      headers: authHeaders(token, staleRequestId),
    });
    expect(staleResponse.status(), await staleResponse.text()).toBe(409);
    expect(loadSyncEvidence(createRequestId).finalDeadlineCount).toBe(1);

    runRuntimeCommand(disableCommand, 'disable order-save sync before restore probe');
    expectBackendOrderSyncFlag(false);
    if (!snapshot) throw new Error('order snapshot is missing');
    restoreOrder(snapshot);
    restoreFixtureRows(capturedDeadlineIds);
    expectResidueEmpty(loadResidueCounts(capturedDeadlineIds));

    const restored = await loadOrderForSave(request, token);
    const disabledPayload = buildSavePayload(restored, {
      plannedCompletionDate,
      notesSuffix: `[${fixtureKey}:disabled]`,
      idempotencyKey: `${requestIdPrefix}:idempotency:disabled`,
    });
    await saveOrder(request, token, disabledPayload, disabledRequestId);
    expectResidueEmpty(loadResidueCounts(capturedDeadlineIds));

    console.log(
      JSON.stringify({
        fixtureKey,
        targetEnv: process.env.DEADLINE_ORDER_SAVE_SYNC_TARGET_ENV,
        composeProject: process.env.COMPOSE_PROJECT_NAME,
        backendContainer,
        postgresContainer,
        backendApiUrl,
        fixtureOrderId,
        deadlineIds: capturedDeadlineIds,
        createRequestId,
        staleRequestId,
        disabledRequestId,
      }),
    );
  });
});

function requireCanaryEnv() {
  if (process.env.DEADLINE_ORDER_SAVE_SYNC_STAGE_CANARY !== 'true') {
    throw new Error('DEADLINE_ORDER_SAVE_SYNC_STAGE_CANARY=true is required');
  }
  if (process.env.DEADLINE_ORDER_SAVE_SYNC_RESTORE !== 'true') {
    throw new Error('DEADLINE_ORDER_SAVE_SYNC_RESTORE=true is required');
  }
  if (process.env.DEADLINE_ORDER_SAVE_SYNC_TARGET_ENV !== 'backend-test') {
    throw new Error('DEADLINE_ORDER_SAVE_SYNC_TARGET_ENV=backend-test is required');
  }
  if (process.env.COMPOSE_PROJECT_NAME !== 'erp_test') {
    throw new Error('COMPOSE_PROJECT_NAME=erp_test is required');
  }
  if (fixtureKey !== expectedFixtureKey) {
    throw new Error(`DEADLINE_ORDER_SAVE_SYNC_FIXTURE_KEY=${expectedFixtureKey} is required`);
  }
  if (!fixtureOrderId) {
    throw new Error('DEADLINE_ORDER_SAVE_SYNC_FIXTURE_ORDER_ID is required');
  }
}

async function loginForApiToken(
  request: APIRequestContext,
  username: string,
  password: string,
): Promise<string> {
  const response = await request.post(`${backendApiUrl}/auth/login`, {
    data: { username, password },
  });
  await expectOk(response);
  const body = await response.json();
  expect(typeof body.accessToken).toBe('string');
  return body.accessToken;
}

async function loadOrderForSave(
  request: APIRequestContext,
  token: string,
): Promise<OrderResponse> {
  const response = await request.get(`${backendApiUrl}/orders/${fixtureOrderId}`, {
    headers: authHeaders(token, `load:${requestIdPrefix}`),
  });
  await expectOk(response);
  return response.json() as Promise<OrderResponse>;
}

async function saveOrder(
  request: APIRequestContext,
  token: string,
  payload: SaveOrderPayload,
  requestId: string,
): Promise<OrderResponse> {
  const response = await request.put(`${backendApiUrl}/orders/${fixtureOrderId}`, {
    data: payload,
    headers: authHeaders(token, requestId),
  });
  await expectOk(response);
  return response.json() as Promise<OrderResponse>;
}

function authHeaders(token: string, requestId: string) {
  return {
    Authorization: `Bearer ${token}`,
    'x-request-id': requestId,
  };
}

function buildSavePayload(
  response: OrderResponse,
  input: { plannedCompletionDate: string; notesSuffix: string; idempotencyKey: string },
): SaveOrderPayload {
  const order = response.order;
  const header = order.header;
  return {
    version: header.version,
    idempotencyKey: input.idempotencyKey,
    header: {
      orderId: fixtureOrderId,
      orderName: header.orderName,
      clientId: header.clientId,
      orderDate: dateOnly(header.orderDate),
      priority: header.priority,
      managerId: header.managerId,
      orderStatusId: header.orderStatusId,
      paymentStatusId: header.paymentStatusId,
      productionStatusId: header.productionStatusId,
      productionStatusFromDetailsEnabled: header.productionStatusFromDetailsEnabled,
      plannedCompletionDate: input.plannedCompletionDate,
      completionDate: null,
      issueDate: dateOnlyOrNull(header.issueDate),
      paymentDate: dateOnlyOrNull(header.paymentDate),
      discount: header.discount,
      surcharge: header.surcharge,
      linkCuttingFile: header.linkCuttingFile,
      linkCuttingImageFile: header.linkCuttingImageFile,
      linkCadFile: header.linkCadFile,
      linkPdfFile: header.linkPdfFile,
      notes: `${header.notes ?? ''} ${input.notesSuffix}`.trim(),
      refKey1c: header.refKey1c,
      materialId: header.materialId,
      millingTypeId: header.millingTypeId,
      edgeTypeId: header.edgeTypeId,
      filmId: header.filmId,
    },
    details: order.details.map((detail) => ({
      id: detail.id,
      detailNumber: detail.detailNumber,
      detailName: detail.detailName,
      height: detail.height,
      width: detail.width,
      quantity: detail.quantity,
      materialId: detail.materialId,
      millingTypeId: detail.millingTypeId,
      edgeTypeId: detail.edgeTypeId,
      filmId: detail.filmId,
      area: detail.area,
      millingCostPerSqm: detail.millingCostPerSqm,
      detailCost: detail.detailCost,
      priority: detail.priority,
      productionStatusId: detail.productionStatusId,
      jointOrderId: detail.jointOrderId,
      note: detail.note,
      linkCuttingFile: detail.linkCuttingFile,
      linkCuttingImageFile: detail.linkCuttingImageFile,
      linkCadFile: detail.linkCadFile,
      linkPdfFile: detail.linkPdfFile,
      refKey1c: detail.refKey1c,
    })),
    payments: order.payments.map((payment) => ({
      id: payment.id,
      typePaidId: payment.typePaidId,
      amount: payment.amount,
      paymentDate: dateOnly(payment.paymentDate),
      notes: payment.notes,
      refKey1c: payment.refKey1c,
    })),
    workshops: order.workshops.map((workshop) => ({
      id: workshop.id,
      workshopId: workshop.workshopId,
      productionStatusId: workshop.productionStatusId,
      receivedDate: dateOnlyOrNull(workshop.receivedDate),
      startedDate: dateOnlyOrNull(workshop.startedDate),
      completedDate: dateOnlyOrNull(workshop.completedDate),
      plannedCompletionDate: null,
      sequenceOrder: workshop.sequenceOrder,
      responsibleEmployeeId: workshop.responsibleEmployeeId,
      notes: workshop.notes,
      refKey1c: workshop.refKey1c,
    })),
    requirements: order.requirements.map((requirement) => ({
      id: requirement.id,
      resourceType: requirement.resourceType,
      materialId: requirement.materialId,
      filmId: requirement.filmId,
      edgeTypeId: requirement.edgeTypeId,
      requiredQuantity: requirement.requiredQuantity,
      unitId: requirement.unitId,
      wastePercentage: requirement.wastePercentage,
      finalQuantity: requirement.finalQuantity,
      requirementStatusId: requirement.requirementStatusId,
      supplierId: requirement.supplierId,
      purchasePrice: requirement.purchasePrice,
      requisitionId: requirement.requisitionId,
      warehouseId: requirement.warehouseId,
      reservedAt: dateOnlyOrNull(requirement.reservedAt),
      consumedAt: dateOnlyOrNull(requirement.consumedAt),
      notes: requirement.notes,
      calculationDetails: requirement.calculationDetails,
      refKey1c: requirement.refKey1c,
    })),
    dowelingLinks: order.dowelingLinks.map((link) => ({
      id: link.id,
      dowelingOrderId: link.dowelingOrderId,
      designEngineerId: link.designEngineerId,
      refKey1c: link.refKey1c,
    })),
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
  };
}

function loadOrderSnapshot(): OrderSnapshot {
  return psql<OrderSnapshot>(
    `
    SELECT json_build_object(
      'orderId', order_id,
      'plannedCompletionDate', planned_completion_date::text,
      'completionDate', completion_date::text,
      'notes', notes,
      'version', version
    )::text
    FROM orders
    WHERE order_id = ${fixtureOrderId};
    `,
    { json: true },
  );
}

function restoreOrder(order: OrderSnapshot) {
  psql(`
    UPDATE orders
    SET planned_completion_date = ${nullableSql(order.plannedCompletionDate)}::date,
        completion_date = ${nullableSql(order.completionDate)}::date,
        notes = ${nullableSql(order.notes)},
        version = ${order.version}
    WHERE order_id = ${order.orderId};
  `);
}

function restoreFixtureRows(knownDeadlineIds: string[] = []) {
  psql(`
    WITH scoped_deadlines AS (
      SELECT deadline_id::text
      FROM deadline_instances
      WHERE order_id = ${fixtureOrderId}
        AND (
          entity_type IN ('order', 'order_stage')
          AND (
            metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
            OR deadline_id::text IN (${quotedCsv(knownDeadlineIds)})
            OR deadline_id::text IN (
              SELECT deadline_id::text
              FROM deadline_events
              WHERE order_id = ${fixtureOrderId}
                AND payload_json->>'requestId' LIKE '${escapeSql(requestIdPrefix)}%'
            )
          )
        )
    ),
    scoped_events AS (
      SELECT deadline_event_id::text
      FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadlines)
         OR (
          order_id = ${fixtureOrderId}
          AND payload_json->>'requestId' LIKE '${escapeSql(requestIdPrefix)}%'
        )
    ),
    deleted_action_executions AS (
      DELETE FROM deadline_action_executions
      WHERE deadline_event_id::text IN (SELECT deadline_event_id FROM scoped_events)
      RETURNING 1
    ),
    deleted_notifications AS (
      DELETE FROM notifications
      WHERE (
          source_type = 'deadline'
          AND source_id IN (SELECT deadline_event_id FROM scoped_events)
        )
         OR (
          entity_type = 'deadline'
          AND entity_id IN (SELECT deadline_id FROM scoped_deadlines)
        )
      RETURNING 1
    ),
    deleted_outbox AS (
      DELETE FROM outbox_events
      WHERE (
          aggregate_type = 'deadline'
          AND (
            aggregate_id IN (SELECT deadline_id FROM scoped_deadlines)
            OR payload_json->>'deadlineEventId' IN (SELECT deadline_event_id FROM scoped_events)
          )
        )
        OR (
          aggregate_type = 'order'
          AND aggregate_id = '${fixtureOrderId}'
          AND payload_json->>'requestId' LIKE '${escapeSql(requestIdPrefix)}%'
        )
      RETURNING 1
    ),
    deleted_audit AS (
      DELETE FROM audit_log
      WHERE (
          entity_type = 'deadline'
          AND (
            entity_id IN (SELECT deadline_id FROM scoped_deadlines)
            OR metadata_json->>'deadlineEventId' IN (SELECT deadline_event_id FROM scoped_events)
          )
        )
        OR request_id LIKE '${escapeSql(requestIdPrefix)}%'
      RETURNING 1
    ),
    deleted_idempotency AS (
      DELETE FROM command_idempotency_keys
      WHERE (
          idempotency_key = '${escapeSql(lockKey)}'
          AND (
            status <> 'processing'
            OR created_at < now() - interval '2 hours'
          )
        )
         OR idempotency_key LIKE '${escapeSql(requestIdPrefix)}%'
      RETURNING 1
    ),
    deleted_events AS (
      DELETE FROM deadline_events
      WHERE deadline_event_id::text IN (SELECT deadline_event_id FROM scoped_events)
      RETURNING 1
    )
    DELETE FROM deadline_instances
    WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadlines);
  `);
}

function loadResidueCounts(knownDeadlineIds: string[] = []): ResidueCounts {
  return psql<ResidueCounts>(
    `
    WITH scoped_deadlines AS (
      SELECT deadline_id::text
      FROM deadline_instances
      WHERE order_id = ${fixtureOrderId}
        AND (
          metadata_json->>'fixtureKey' = '${escapeSql(fixtureKey)}'
          OR deadline_id::text IN (${quotedCsv(knownDeadlineIds)})
          OR deadline_id::text IN (
            SELECT deadline_id::text
            FROM deadline_events
            WHERE order_id = ${fixtureOrderId}
              AND payload_json->>'requestId' LIKE '${escapeSql(requestIdPrefix)}%'
          )
        )
    ),
    scoped_events AS (
      SELECT deadline_event_id::text
      FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM scoped_deadlines)
         OR (
          order_id = ${fixtureOrderId}
          AND payload_json->>'requestId' LIKE '${escapeSql(requestIdPrefix)}%'
        )
    )
    SELECT json_build_object(
      'deadlineInstances', (SELECT count(*)::int FROM scoped_deadlines),
      'deadlineEvents', (SELECT count(*)::int FROM scoped_events),
      'deadlineActionExecutions', (
        SELECT count(*)::int FROM deadline_action_executions
        WHERE deadline_event_id::text IN (SELECT deadline_event_id FROM scoped_events)
      ),
      'commandIdempotencyKeys', (
        SELECT count(*)::int FROM command_idempotency_keys
        WHERE (
            idempotency_key = '${escapeSql(lockKey)}'
            AND status <> 'processing'
          )
           OR idempotency_key LIKE '${escapeSql(requestIdPrefix)}%'
      ),
      'auditLog', (
        SELECT count(*)::int FROM audit_log
        WHERE request_id LIKE '${escapeSql(requestIdPrefix)}%'
           OR (
            entity_type = 'deadline'
            AND entity_id IN (SELECT deadline_id FROM scoped_deadlines)
          )
      ),
      'outboxEvents', (
        SELECT count(*)::int FROM outbox_events
        WHERE (
            aggregate_type = 'deadline'
            AND aggregate_id IN (SELECT deadline_id FROM scoped_deadlines)
          )
          OR (
            aggregate_type = 'order'
            AND aggregate_id = '${fixtureOrderId}'
            AND payload_json->>'requestId' LIKE '${escapeSql(requestIdPrefix)}%'
          )
      ),
      'notifications', (
        SELECT count(*)::int FROM notifications
        WHERE (
            source_type = 'deadline'
            AND source_id IN (SELECT deadline_event_id FROM scoped_events)
          )
           OR (
            entity_type = 'deadline'
            AND entity_id IN (SELECT deadline_id FROM scoped_deadlines)
          )
      )
    )::text;
    `,
    { json: true },
  );
}

function loadSyncEvidence(requestId: string): SyncEvidence {
  return psql<SyncEvidence>(
    `
    WITH final_deadlines AS (
      SELECT deadline_id::text
      FROM deadline_instances
      WHERE order_id = ${fixtureOrderId}
        AND entity_type = 'order'
        AND status = 'active'
        AND (deadline_at AT TIME ZONE 'UTC')::date = '${escapeSql(plannedCompletionDate)}'::date
    ),
    stage_deadlines AS (
      SELECT deadline_id::text
      FROM deadline_instances
      WHERE order_id = ${fixtureOrderId}
        AND entity_type = 'order_stage'
        AND status = 'active'
        AND (deadline_at AT TIME ZONE 'UTC')::date = '${escapeSql(plannedCompletionDate)}'::date
    ),
    fixture_events AS (
      SELECT deadline_event_id::text, deadline_id::text
      FROM deadline_events
      WHERE deadline_id::text IN (SELECT deadline_id FROM final_deadlines)
        AND payload_json->>'requestId' = '${escapeSql(requestId)}'
    )
    SELECT json_build_object(
      'deadlineIds', COALESCE((SELECT json_agg(deadline_id) FROM final_deadlines), '[]'::json),
      'finalDeadlineCount', (SELECT count(*)::int FROM final_deadlines),
      'stageDeadlineCount', (SELECT count(*)::int FROM stage_deadlines),
      'eventRows', (SELECT count(*)::int FROM fixture_events),
      'auditRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE entity_type = 'deadline'
          AND entity_id IN (SELECT deadline_id FROM final_deadlines)
          AND related_order_id = ${fixtureOrderId}
          AND request_id = '${escapeSql(requestId)}'
      ),
      'auditRequestRows', (
        SELECT count(*)::int
        FROM audit_log
        WHERE request_id = '${escapeSql(requestId)}'
      ),
      'outboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'deadline'
          AND aggregate_id IN (SELECT deadline_id FROM final_deadlines)
          AND payload_json->>'orderId' = '${fixtureOrderId}'
          AND payload_json->>'requestId' = '${escapeSql(requestId)}'
      ),
      'outboxRequestRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE payload_json->>'requestId' = '${escapeSql(requestId)}'
      ),
      'orderOutboxRows', (
        SELECT count(*)::int
        FROM outbox_events
        WHERE aggregate_type = 'order'
          AND aggregate_id = '${fixtureOrderId}'
          AND payload_json->>'requestId' = '${escapeSql(requestId)}'
      )
    )::text;
    `,
    { json: true },
  );
}

function expectResidueEmpty(counts: ResidueCounts) {
  expect(counts.deadlineInstances).toBe(0);
  expect(counts.deadlineEvents).toBe(0);
  expect(counts.deadlineActionExecutions).toBe(0);
  expect(counts.commandIdempotencyKeys).toBe(0);
  expect(counts.auditLog).toBe(0);
  expect(counts.outboxEvents).toBe(0);
  expect(counts.notifications).toBe(0);
}

function expectNoStageDeadlineInputs() {
  const plannedStageCount = Number(
    psql(`
      SELECT count(*)::int
      FROM order_workshops
      WHERE order_id = ${fixtureOrderId}
        AND delete_flag = false
        AND planned_completion_date IS NOT NULL;
    `),
  );
  expect(plannedStageCount, 'fixture order must not create stage deadlines').toBe(0);
}

function acquireExclusiveWindow() {
  expectNoActiveWindow();

  psql(`
    INSERT INTO command_idempotency_keys (
      idempotency_key, command_name, actor_user_id, entity_type, entity_id,
      request_hash, response_json, status
    )
    VALUES (
      '${escapeSql(lockKey)}',
      'deadline-order-save-sync-stage-canary',
      NULL,
      'order',
      '${fixtureOrderId}',
      '${crypto.createHash('sha256').update(lockKey).digest('hex')}',
      json_build_object(
        'fixtureKey', '${escapeSql(fixtureKey)}',
        'targetEnv', 'backend-test',
        'composeProject', 'erp_test',
        'backendContainer', '${escapeSql(backendContainer)}',
        'postgresContainer', '${escapeSql(postgresContainer)}',
        'backendApiUrl', '${escapeSql(backendApiUrl)}',
        'branch', '${escapeSql(currentBranch())}',
        'commit', '${escapeSql(currentCommit())}',
        'startedAt', now()
      ),
      'processing'
    );
  `);
}

function expectNoActiveWindow() {
  const activeLocks = Number(
    psql(`
      SELECT count(*)::int
      FROM command_idempotency_keys
      WHERE command_name = 'deadline-order-save-sync-stage-canary'
        AND status = 'processing'
        AND created_at >= now() - interval '2 hours';
    `),
  );
  expect(activeLocks, 'another Deadline order-save sync canary window is active').toBe(0);
}

function releaseExclusiveWindow() {
  psql(`
    UPDATE command_idempotency_keys
    SET status = 'completed',
        completed_at = now(),
        response_json = COALESCE(response_json, '{}'::jsonb) || jsonb_build_object('endedAt', now())
    WHERE idempotency_key = '${escapeSql(lockKey)}';
  `);
}

function expectBackendOrderSyncFlag(expected: boolean) {
  const value = dockerExec(backendContainer, [
    'sh',
    '-lc',
    'printf %s "${BACKEND_ENABLE_DEADLINE_ORDER_SYNC:-false}"',
  ]);
  expect(value).toBe(String(expected));
}

function runRuntimeCommand(command: string, label: string) {
  if (!command.trim()) {
    throw new Error(`${label} command is required`);
  }
  execFileSync('/bin/bash', ['-lc', command], {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
    env: process.env,
  });
}

function createSmokeUser(username: string, password: string): number {
  const email = `${username}@example.invalid`;
  const passwordHash = bcrypt.hashSync(password, 10);

  return Number(
    psql(`
      WITH inserted AS (
        INSERT INTO users (username, email, password_hash, role_id, full_name, is_active)
        VALUES (
          '${escapeSql(username)}',
          '${escapeSql(email)}',
          '${escapeSql(passwordHash)}',
          2,
          'E2E Deadline Order Save Sync Canary',
          true
        )
        RETURNING user_id
      )
      SELECT user_id FROM inserted;
    `),
  );
}

function cleanupUser(id: number | null) {
  if (!id) return;

  psql(`
    DELETE FROM refresh_tokens WHERE user_id = ${id};
    DELETE FROM auth_sessions WHERE user_id = ${id};
    UPDATE users
    SET is_active = false,
        edited_by = NULL
    WHERE user_id = ${id};
  `);
}

async function expectOk(response: APIResponse) {
  expect(response.ok(), await response.text()).toBe(true);
}

function psql<T = string>(sql: string, options: { json?: boolean } = {}): T {
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      postgresContainer,
      'psql',
      '-U',
      'erp_user',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();

  if (options.json) {
    if (!output) throw new Error('SQL query returned no JSON output');
    return JSON.parse(output) as T;
  }

  return output as T;
}

function dockerExec(container: string, args: string[]): string {
  return execFileSync('docker', ['exec', container, ...args], { encoding: 'utf8' }).trim();
}

function dockerContainerExists(containerName: string): boolean {
  if (!containerName) return false;
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function assertBackendTestApiUrl(value: string) {
  const parsed = new URL(value);
  expect(parsed.hostname, 'canary must target backend-test').toBe('backend-test.mebelkz.app');
  expect(parsed.pathname.replace(/\/+$/, ''), 'backend API path must be /api/v1').toBe('/api/v1');
}

function assertNonProductionLikeContainer(container: string, label: string) {
  const lower = container.toLowerCase();
  const safe =
    lower.includes('test') ||
    lower.includes('stage') ||
    lower.includes('staging') ||
    lower.includes('dev') ||
    lower.includes('local');
  if (!safe) {
    throw new Error(`Refusing to run against production-like ${label} container: ${container}`);
  }
}

function currentBranch(): string {
  return execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
}

function currentCommit(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function dateOnlyOrNull(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

function nullableSql(value: string | number | null): string {
  return value === null ? 'NULL' : `'${escapeSql(String(value))}'`;
}

function quotedCsv(values: string[]): string {
  if (values.length === 0) return "''";
  return values.map((value) => `'${escapeSql(value)}'`).join(', ');
}

function readNumberEnv(name: string): number | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}

interface OrderSnapshot {
  orderId: number;
  plannedCompletionDate: string | null;
  completionDate: string | null;
  notes: string | null;
  version: number;
}

interface ResidueCounts {
  deadlineInstances: number;
  deadlineEvents: number;
  deadlineActionExecutions: number;
  commandIdempotencyKeys: number;
  auditLog: number;
  outboxEvents: number;
  notifications: number;
}

interface SyncEvidence {
  deadlineIds: string[];
  finalDeadlineCount: number;
  stageDeadlineCount: number;
  eventRows: number;
  auditRows: number;
  auditRequestRows: number;
  outboxRows: number;
  outboxRequestRows: number;
  orderOutboxRows: number;
}

interface OrderResponse {
  order: {
    header: Record<string, any>;
    details: Array<Record<string, any>>;
    payments: Array<Record<string, any>>;
    workshops: Array<Record<string, any>>;
    requirements: Array<Record<string, any>>;
    dowelingLinks: Array<Record<string, any>>;
  };
}

type SaveOrderPayload = Record<string, any>;
