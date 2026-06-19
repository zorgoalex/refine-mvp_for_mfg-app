/**
 * Twenty-sync stage canary (Task 11)
 *
 * Fail-closed: self-skips unless TWENTY_SYNC_STAGE_CANARY=true AND backend host
 * contains 'backend-test'. Rejects prod/production/live hosts unconditionally.
 *
 * Must be run during a flag-on window by an operator.
 * Never run in normal CI gates.
 *
 * Zero-residue: cleans up both Twenty and ERP (clients, orders,
 * crm_sync_mapping, crm_sync_outbox) after the test.
 */

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// ── Canary flag + env resolution ──────────────────────────────────────────────

const canaryEnabled = process.env.TWENTY_SYNC_STAGE_CANARY === 'true';

const backendApiUrl = trimTrailingSlash(
  process.env.TWENTY_SYNC_STAGE_BACKEND_API_URL ??
    process.env.BACKEND_STAGE_URL ??
    'https://backend-test.mebelkz.app/api/v1',
);

const postgresContainer =
  process.env.TWENTY_SYNC_STAGE_POSTGRES_CONTAINER ?? 'erp_test-postgresdb-1';

const twentyBaseUrl = trimTrailingSlash(
  process.env.TWENTY_SYNC_STAGE_TWENTY_URL ?? 'https://crm-test.mebelkz.app',
);

// NEVER printed — used only in Bearer header
const twentyApiKey = process.env.TWENTY_SYNC_API_KEY;

// ── Host safety checks ────────────────────────────────────────────────────────

/**
 * True if the backend URL is safe to use (backend-test only).
 * Parses the hostname and requires an EXACT or anchored prefix match.
 * NOTE: do NOT call this at module top-level — URL parsing fails when the env
 * var is missing or malformed and would crash the module on load.
 */
function isBackendTestHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (/prod|production|live/i.test(host)) return false;
  return host === 'backend-test.mebelkz.app' || /^backend-test\./.test(host);
}

/**
 * True if the Twenty REST base URL is safe to use (test CRM only).
 * Parses the hostname and requires an EXACT or anchored prefix match.
 * NOTE: this MUST be the host-facing URL (e.g. https://crm-test.mebelkz.app),
 * never the internal docker URL (http://twenty:3000) which is unreachable from
 * the host shell. We deliberately do NOT fall back to TWENTY_SYNC_BASE_URL.
 * NOTE: do NOT call this at module top-level — URL parsing fails when the env
 * var is missing or malformed and would crash the module on load.
 */
function isTwentyTestHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (/prod|production|live/i.test(host)) return false;
  return host === 'crm-test.mebelkz.app' || /^crm-test\./.test(host);
}

/**
 * True if the postgres container name is safe to target (test only).
 * Uses an ANCHORED allowlist regex — accepts ONLY the expected test container
 * pattern, not any arbitrary string containing 'test'.
 */
function isTestPostgresContainer(name: string): boolean {
  if (/prod|production|live/i.test(name)) return false;
  return /^erp_test-postgresdb(-\d+)?$/.test(name);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function sqlQuote(value: string): string {
  return value.replace(/'/g, "''");
}

function isTestData(value: string): boolean {
  return value.startsWith('Тест') || value.startsWith('E2E-Тест') || value.startsWith('E2E');
}

function psql<T>(sql: string, options: { json: true }): T;
function psql(sql: string, options?: { json?: false }): string;
function psql(sql: string, options: { json?: boolean } = {}): unknown {
  const output = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      postgresContainer,
      'psql',
      '-U',
      'postgres',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    {
      input: sql,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    },
  ).trim();

  if (!options.json) return output;
  if (!output) {
    throw new Error(`Expected JSON from SQL, got empty output for: ${sql.slice(0, 120)}`);
  }
  return JSON.parse(output);
}

function dockerContainerExists(containerName: string): boolean {
  try {
    execFileSync('docker', ['container', 'inspect', containerName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ── Twenty REST helpers ───────────────────────────────────────────────────────

type TwentyObject = 'companies' | 'erpOrders';

/**
 * Find a Twenty record by erpId. Returns null if not found.
 * NEVER logs the API key.
 */
async function findIdByErpId(object: TwentyObject, erpId: string): Promise<string | null> {
  const filterValue = encodeURIComponent(`erpId[eq]:${erpId}`);
  const url = `${twentyBaseUrl}/rest/${object}?filter=${filterValue}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${twentyApiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twenty findIdByErpId ${object} (erpId omitted) → ${res.status}`);
  }
  const json = (await res.json()) as { data?: Record<string, Array<{ id?: string }> | undefined> };
  return json.data?.[object]?.[0]?.id ?? null;
}

/**
 * Read erpStatus from a Twenty record found by erpId.
 */
async function findErpStatus(object: TwentyObject, erpId: string): Promise<string | null> {
  const filterValue = encodeURIComponent(`erpId[eq]:${erpId}`);
  const url = `${twentyBaseUrl}/rest/${object}?filter=${filterValue}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${twentyApiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twenty findErpStatus ${object} → ${res.status}`);
  }
  const json = (await res.json()) as {
    data?: Record<string, Array<{ id?: string; erpStatus?: string }> | undefined>;
  };
  return json.data?.[object]?.[0]?.erpStatus ?? null;
}

/**
 * Delete a Twenty record by its internal id.
 */
async function deleteRecord(object: TwentyObject, id: string): Promise<void> {
  const res = await fetch(`${twentyBaseUrl}/rest/${object}/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${twentyApiKey}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Twenty deleteRecord ${object}/${id} → ${res.status}`);
  }
}

/**
 * Poll Twenty until findIdByErpId returns non-null for BOTH company and order,
 * or until timeoutMs is reached. Returns both ids.
 */
async function pollUntilBothSynced(
  clientErpId: string,
  orderErpId: string,
  timeoutMs = 120_000,
  intervalMs = 3_000,
): Promise<{ companyTwentyId: string; orderTwentyId: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [companyId, orderId] = await Promise.all([
      findIdByErpId('companies', clientErpId),
      findIdByErpId('erpOrders', orderErpId),
    ]);
    if (companyId && orderId) {
      return { companyTwentyId: companyId, orderTwentyId: orderId };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timeout: Twenty records not found for client erpId=${clientErpId} / order erpId=${orderErpId} after ${timeoutMs}ms`,
  );
}

/**
 * Poll Twenty until Company erpStatus equals the expected value.
 */
async function pollUntilErpStatus(
  erpId: string,
  expectedStatus: string,
  timeoutMs = 60_000,
  intervalMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await findErpStatus('companies', erpId);
    if (status === expectedStatus) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `Timeout: Company erpStatus did not become '${expectedStatus}' after ${timeoutMs}ms`,
  );
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

interface SeededFixture {
  clientId: number;
  orderId: number;
}

/**
 * Inserts fixture client + order into the ERP DB.
 * Uses SET LOCAL app.user_id so the created_by trigger resolves correctly.
 */
function seedFixture(clientName: string, orderName: string, runId: string): SeededFixture {
  const result = psql<{ clientId: number; orderId: number }>(
    `
    BEGIN;
    SET LOCAL app.user_id = '1';

    WITH ins_client AS (
      INSERT INTO clients (client_name, notes, is_active)
      VALUES (
        '${sqlQuote(clientName)}',
        'E2E-Тест CRM sync canary ${sqlQuote(runId)}',
        true
      )
      RETURNING client_id
    ),
    ins_order AS (
      INSERT INTO orders (
        order_name,
        client_id,
        order_status_id,
        payment_status_id,
        created_by
      )
      SELECT
        '${sqlQuote(orderName)}',
        client_id,
        (SELECT order_status_id FROM order_statuses ORDER BY sort_order ASC LIMIT 1),
        (SELECT payment_status_id FROM payment_statuses ORDER BY sort_order ASC LIMIT 1),
        1
      FROM ins_client
      RETURNING order_id, client_id
    )
    SELECT json_build_object(
      'clientId', ins_client.client_id,
      'orderId', ins_order.order_id
    )::text
    FROM ins_client
    CROSS JOIN ins_order;

    COMMIT;
    `,
    { json: true },
  );
  return { clientId: Number(result.clientId), orderId: Number(result.orderId) };
}

/**
 * Trigger a no-op UPDATE on the client to re-enqueue a sync outbox event.
 */
function retriggerClientSync(clientId: number, clientName: string): void {
  if (!isTestData(clientName)) {
    throw new Error(`retriggerClientSync: not a test client — aborting (id=${clientId})`);
  }
  psql(`
    UPDATE clients
    SET notes = notes
    WHERE client_id = ${Number(clientId)}
      AND client_name = '${sqlQuote(clientName)}';
  `);
}

/**
 * Soft-delete client in ERP (is_active=false) to trigger a delete sync.
 */
function softDeleteClientInErp(clientId: number, clientName: string): void {
  if (!isTestData(clientName)) {
    throw new Error(`softDeleteClientInErp: not a test client — aborting (id=${clientId})`);
  }
  psql(`
    UPDATE clients
    SET is_active = false
    WHERE client_id = ${Number(clientId)}
      AND client_name = '${sqlQuote(clientName)}';
  `);
}

/**
 * Delete all ERP fixture rows for this run.
 * Guards every deletion with the fixture prefix + specific id.
 */
function cleanupErpFixture(
  clientId: number,
  clientName: string,
  orderId: number,
): void {
  if (!isTestData(clientName)) {
    throw new Error(`cleanupErpFixture: not a test client name — aborting (id=${clientId})`);
  }

  // Verify the client name is test-prefixed before deleting (safety double-check)
  const nameInDb = psql(
    `SELECT client_name FROM clients WHERE client_id = ${Number(clientId)};`,
  ).trim();
  if (nameInDb && !isTestData(nameInDb)) {
    throw new Error(
      `cleanupErpFixture: DB name '${nameInDb}' lacks test prefix — refusing to delete`,
    );
  }

  // Step 1: Delete ERP fixture rows FIRST — these fire the 025 triggers which
  // enqueue fresh crm_sync_outbox delete events for the fixture ids.
  psql(`
    DELETE FROM orders
    WHERE order_id = ${Number(orderId)}
      AND client_id = ${Number(clientId)};

    DELETE FROM clients
    WHERE client_id = ${Number(clientId)}
      AND client_name = '${sqlQuote(clientName)}';
  `);

  // Step 2: Purge crm-sync rows LAST — after the trigger-generated rows exist —
  // so that assertZeroErpResidue finds nothing (no trigger-generated residue).
  psql(`
    DELETE FROM crm_sync_outbox
    WHERE aggregate_id = '${Number(clientId)}'
      AND aggregate_type = 'crm_sync'
      AND payload_json->>'entity' = 'client';

    DELETE FROM crm_sync_outbox
    WHERE aggregate_id = '${Number(orderId)}'
      AND aggregate_type = 'crm_sync'
      AND payload_json->>'entity' = 'order';

    DELETE FROM crm_sync_mapping
    WHERE entity_type = 'client' AND erp_id = '${Number(clientId)}';

    DELETE FROM crm_sync_mapping
    WHERE entity_type = 'order' AND erp_id = '${Number(orderId)}';
  `);
}

/**
 * Assert zero ERP residue for the fixture ids.
 */
function assertZeroErpResidue(
  clientId: number,
  clientName: string,
  orderId: number,
): void {
  const result = psql<{
    clientExists: boolean;
    orderExists: boolean;
    mappingCount: number;
    outboxCount: number;
  }>(
    `
    SELECT json_build_object(
      'clientExists', EXISTS (SELECT 1 FROM clients WHERE client_id = ${Number(clientId)}),
      'orderExists', EXISTS (SELECT 1 FROM orders WHERE order_id = ${Number(orderId)}),
      'mappingCount', (
        SELECT count(*) FROM crm_sync_mapping
        WHERE (entity_type = 'client' AND erp_id = '${Number(clientId)}')
           OR (entity_type = 'order' AND erp_id = '${Number(orderId)}')
      ),
      'outboxCount', (
        SELECT count(*) FROM crm_sync_outbox
        WHERE (aggregate_id = '${Number(clientId)}' AND payload_json->>'entity' = 'client'
               AND aggregate_type = 'crm_sync')
           OR (aggregate_id = '${Number(orderId)}' AND payload_json->>'entity' = 'order'
               AND aggregate_type = 'crm_sync')
      )
    )::text;
    `,
    { json: true },
  );

  expect(result.clientExists, `Client ${clientId} should not exist after cleanup`).toBe(false);
  expect(result.orderExists, `Order ${orderId} should not exist after cleanup`).toBe(false);
  expect(Number(result.mappingCount), 'crm_sync_mapping residue').toBe(0);
  expect(Number(result.outboxCount), 'crm_sync_outbox residue').toBe(0);

  void clientName; // referenced for isTestData check upstream
}

// ── Test suite ────────────────────────────────────────────────────────────────

test.describe('Twenty sync stage canary', () => {
  // Fail-closed guard 1: explicit flag
  test.skip(!canaryEnabled, 'Run with TWENTY_SYNC_STAGE_CANARY=true');

  // Fail-closed guard 2: backend host must be backend-test.mebelkz.app (anchored) and must NOT be prod
  test.skip(
    canaryEnabled && !isBackendTestHost(backendApiUrl),
    `Backend host must be 'backend-test.mebelkz.app' (anchored) and must not be prod/production/live. Got: [REDACTED]`,
  );

  // Fail-closed guard 3: Twenty REST base URL must be crm-test.mebelkz.app (anchored) and must NOT be prod
  test.skip(
    canaryEnabled && !isTwentyTestHost(twentyBaseUrl),
    `Twenty URL must be 'crm-test.mebelkz.app' (anchored) and must not be prod/production/live. Got: [REDACTED]`,
  );

  // Fail-closed guard 4: postgres container name must match anchored allowlist pattern and must exist
  test.skip(
    canaryEnabled && !isTestPostgresContainer(postgresContainer),
    `Postgres container name must match /^erp_test-postgresdb(-\\d+)?$/ and must not be prod/production/live. Got: [REDACTED]`,
  );

  // Fail-closed guard 5: postgres container must exist
  test.skip(
    canaryEnabled && !dockerContainerExists(postgresContainer),
    `Stage postgres container ${postgresContainer} is required for twenty-sync stage canary.`,
  );

  // Fail-closed guard 6: Twenty API key must be present
  test.skip(
    canaryEnabled && !twentyApiKey,
    'TWENTY_SYNC_API_KEY is required for twenty-sync stage canary.',
  );

  test.setTimeout(300_000);

  // Track state for cleanup on failure
  let clientId: number | null = null;
  let orderId: number | null = null;
  let clientName: string | null = null;
  let companyTwentyId: string | null = null;
  let orderTwentyId: string | null = null;

  test.afterEach(async () => {
    // Best-effort cleanup on failure — mirrors client-phones-stage-canary pattern
    try {
      // Delete erpOrders BEFORE companies to mirror the test-body deletion
      // order (referential safety: avoids leaving an order behind if a
      // company-first delete is constrained).
      if (orderTwentyId) {
        await deleteRecord('erpOrders', orderTwentyId).catch(() => {});
        orderTwentyId = null;
      }
      if (companyTwentyId) {
        await deleteRecord('companies', companyTwentyId).catch(() => {});
        companyTwentyId = null;
      }
    } catch {
      // ignore cleanup errors
    }
    try {
      if (clientId !== null && clientName !== null && orderId !== null) {
        cleanupErpFixture(clientId, clientName, orderId);
        // cleanupErpFixture is sync — no catch needed here
      }
    } catch {
      // ignore cleanup errors
    }
  });

  test(
    'seeds fixture → syncs to Twenty → no duplicate → soft-delete syncs → zero residue cleanup',
    async () => {
      // Hard reject: must be impossible to hit prod even if env is misconfigured.
      // Parse hostnames here (inside the test) to avoid module-load side effects.
      {
        let backendHost: string;
        try {
          backendHost = new URL(backendApiUrl).hostname;
        } catch {
          throw new Error('HARD REJECT: backendApiUrl is not a valid URL');
        }
        if (
          /prod|production|live/i.test(backendHost) ||
          (backendHost !== 'backend-test.mebelkz.app' && !/^backend-test\./.test(backendHost))
        ) {
          throw new Error(
            'HARD REJECT: backend host does not satisfy anchored backend-test requirement',
          );
        }
      }
      {
        let twentyHost: string;
        try {
          twentyHost = new URL(twentyBaseUrl).hostname;
        } catch {
          throw new Error('HARD REJECT: twentyBaseUrl is not a valid URL');
        }
        if (
          /prod|production|live/i.test(twentyHost) ||
          (twentyHost !== 'crm-test.mebelkz.app' && !/^crm-test\./.test(twentyHost))
        ) {
          throw new Error(
            'HARD REJECT: Twenty URL does not satisfy anchored crm-test requirement',
          );
        }
      }
      if (
        /prod|production|live/i.test(postgresContainer) ||
        !/^erp_test-postgresdb(-\d+)?$/.test(postgresContainer)
      ) {
        throw new Error(
          'HARD REJECT: postgres container name does not match anchored allowlist /^erp_test-postgresdb(-\\d+)?$/',
        );
      }

      const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
      clientName = `E2E-Тест CRM ${runId}`;
      const orderNameFixture = `E2E-Тест CRM Order ${runId}`;

      // ── Step 1: Seed fixture in ERP ─────────────────────────────────────────
      const seeded = seedFixture(clientName, orderNameFixture, runId);
      clientId = seeded.clientId;
      orderId = seeded.orderId;

      expect(clientId).toBeGreaterThan(0);
      expect(orderId).toBeGreaterThan(0);

      const clientErpId = String(clientId);
      const orderErpId = String(orderId);

      // ── Step 2: Poll until both Company + ErpOrder appear in Twenty ─────────
      // The DB trigger enqueued outbox events on INSERT; the relay scheduler
      // drains them during the flag-on window. We poll with a 120s timeout.
      const synced = await pollUntilBothSynced(clientErpId, orderErpId, 120_000);
      companyTwentyId = synced.companyTwentyId;
      orderTwentyId = synced.orderTwentyId;

      expect(companyTwentyId).toBeTruthy();
      expect(orderTwentyId).toBeTruthy();

      // ── Step 3: Re-trigger → assert NO duplicate (idempotency) ──────────────
      retriggerClientSync(clientId, clientName);

      // Wait for relay to process the re-trigger outbox event (one poll interval)
      await new Promise((r) => setTimeout(r, 10_000));

      const companyIdAfterRetrigger = await findIdByErpId('companies', clientErpId);
      const orderIdAfterRetrigger = await findIdByErpId('erpOrders', orderErpId);

      // Same id → no duplicate
      expect(companyIdAfterRetrigger).toBe(companyTwentyId);
      expect(orderIdAfterRetrigger).toBe(orderTwentyId);

      // ── Step 4: Soft-delete in ERP → poll until erpStatus='deleted' ─────────
      softDeleteClientInErp(clientId, clientName);

      await pollUntilErpStatus(clientErpId, 'deleted', 60_000);

      const erpStatusAfterDelete = await findErpStatus('companies', clientErpId);
      expect(erpStatusAfterDelete).toBe('deleted');

      // ── Step 5: Cleanup to zero (both systems) ───────────────────────────────

      // Twenty: delete erpOrder first (referential order may matter), then company
      await deleteRecord('erpOrders', orderTwentyId);
      await deleteRecord('companies', companyTwentyId);
      orderTwentyId = null;
      companyTwentyId = null;

      // Assert zero residue in Twenty
      const companyAfterDelete = await findIdByErpId('companies', clientErpId);
      const orderAfterDelete = await findIdByErpId('erpOrders', orderErpId);
      expect(companyAfterDelete).toBeNull();
      expect(orderAfterDelete).toBeNull();

      // ERP: delete fixture rows + mapping + outbox
      cleanupErpFixture(clientId, clientName, orderId);

      // Assert zero ERP residue
      assertZeroErpResidue(clientId, clientName, orderId);

      // Mark cleaned so afterEach no-ops
      clientId = null;
      orderId = null;
      clientName = null;
    },
  );
});

// ── Unused import guard (APIRequestContext not needed here) ───────────────────
// This spec operates purely via psql + fetch — no Playwright page/API context required.
