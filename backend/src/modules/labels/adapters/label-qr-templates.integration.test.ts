import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgLabelsRepository } from './pg-labels-repository';

const databaseUrl = process.env.LABELS_INTEGRATION_DATABASE_URL ?? process.env.CUT_INTEGRATION_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;
const schemaName = `labels_qr_tpl_${randomUUID().replaceAll('-', '_')}`;
const namePrefix = `Тест QR ${Date.now()}`;

const migration049 = readFileSync(new URL('../../../../db/migrations/049_label_qr_templates.sql', import.meta.url), 'utf8');

function currentUser(): CurrentUser {
  return {
    id: '7',
    username: 'labels',
    role: 'admin',
    permissions: ['labels.view', 'labels.manage_templates', 'labels.generate'],
  } as unknown as CurrentUser;
}

async function createPrerequisites(client: Pick<PoolClient, 'query'>): Promise<void> {
  await client.query(`
    CREATE TABLE users (
      user_id BIGINT PRIMARY KEY
    );

    CREATE TABLE command_idempotency_keys (
      idempotency_key TEXT PRIMARY KEY,
      command_name TEXT NOT NULL,
      actor_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_json JSONB,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CONSTRAINT chk_command_idempotency_status
        CHECK (status IN ('processing', 'completed', 'failed'))
    );

    CREATE TABLE audit_log (
      audit_id TEXT PRIMARY KEY DEFAULT md5(random()::text || clock_timestamp()::text),
      event TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      user_id BIGINT,
      username TEXT,
      role_code TEXT,
      role TEXT,
      request_id TEXT,
      source TEXT,
      related_order_id BIGINT,
      related_client_id BIGINT,
      related_payment_id BIGINT,
      related_production_event_id BIGINT,
      related_deadline_id BIGINT,
      related_user_id BIGINT,
      status_field TEXT,
      status_id BIGINT,
      status_name TEXT,
      status_code TEXT,
      stage_code TEXT,
      before_json JSONB,
      after_json JSONB,
      diff_json JSONB,
      metadata_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE audit_log_related_entity (
      audit_id TEXT NOT NULL REFERENCES audit_log(audit_id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id BIGINT NOT NULL,
      UNIQUE (audit_id, entity_type, entity_id)
    );

    INSERT INTO users (user_id) VALUES (7);
  `);
}

function makeDatabase(sessionClient: PoolClient): DatabaseService {
  return {
    isConfigured: true,
    query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      return sessionClient.query<T>(text, [...params]);
    },
    async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
      try {
        await sessionClient.query('BEGIN');
        const tx: TransactionClient = {
          raw: sessionClient as never,
          query: (text: string, params: readonly unknown[] = []) => sessionClient.query(text, [...params]),
        };
        const result = await handler(tx);
        await sessionClient.query('COMMIT');
        return result;
      } catch (error) {
        await sessionClient.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
  } as unknown as DatabaseService;
}

describeIntegration('PgLabelsRepository QR templates (integration)', () => {
  let pool: Pool;
  let sessionClient: PoolClient;
  let repo: PgLabelsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    sessionClient = await pool.connect();
    await sessionClient.query(`CREATE SCHEMA ${schemaName}`);
    await sessionClient.query(`SET search_path TO ${schemaName}`);
    await createPrerequisites(sessionClient);
    await sessionClient.query(migration049);
    repo = new PgLabelsRepository(makeDatabase(sessionClient));
  });

  afterAll(async () => {
    if (pool) {
      await sessionClient.query('SET search_path TO public').catch(() => undefined);
      await sessionClient.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      sessionClient.release();
      await pool.end();
    }
  });

  it('creates a QR template with an audit row and version 1', async () => {
    const name = `${namePrefix} create`;
    const created = await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-qr-create',
      input: {
        name,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-create-key`,
      },
    });

    expect(created.version).toBe(1);
    expect(created.isActive).toBe(true);
    expect(created.name).toBe(name);

    const row = await sessionClient.query(
      'SELECT name, is_active, version FROM label_qr_templates WHERE label_qr_template_id = $1',
      [created.labelQrTemplateId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ name, is_active: true, version: 1 });

    const audit = await sessionClient.query(
      `SELECT event FROM audit_log WHERE event = 'label_qr_template.created' AND entity_id = $1`,
      [String(created.labelQrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('replays a create with the same idempotency key without a second row or audit event', async () => {
    const name = `${namePrefix} replay`;
    const idempotencyKey = `${namePrefix}-replay-key`;
    const input = {
      name,
      contentTemplate: '{bazis.detail_id}',
      errorCorrection: 'M' as const,
      defaultSizeMm: 20,
      idempotencyKey,
    };

    const first = await repo.createQrTemplate({ currentUser: currentUser(), requestId: 'req-replay-1', input });
    const second = await repo.createQrTemplate({ currentUser: currentUser(), requestId: 'req-replay-2', input });

    expect(second.labelQrTemplateId).toBe(first.labelQrTemplateId);

    const rows = await sessionClient.query('SELECT label_qr_template_id FROM label_qr_templates WHERE name = $1', [name]);
    expect(rows.rows).toHaveLength(1);

    const audit = await sessionClient.query(
      `SELECT event FROM audit_log WHERE event = 'label_qr_template.created' AND entity_id = $1`,
      [String(first.labelQrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('rejects a duplicate active name with a 409', async () => {
    const name = `${namePrefix} dup`;
    await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-dup-1',
      input: {
        name,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-dup-key-1`,
      },
    });

    await expect(
      repo.createQrTemplate({
        currentUser: currentUser(),
        requestId: 'req-dup-2',
        input: {
          name,
          contentTemplate: '{bazis.order_id}',
          errorCorrection: 'H',
          defaultSizeMm: 25,
          idempotencyKey: `${namePrefix}-dup-key-2`,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LABEL_QR_TEMPLATE_NAME_TAKEN' });
  });

  it('updates with the correct version to version 2 and audits the change', async () => {
    const name = `${namePrefix} update`;
    const created = await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-update-create',
      input: {
        name,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-update-create-key`,
      },
    });

    const updated = await repo.updateQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-update-1',
      id: created.labelQrTemplateId,
      expectedVersion: created.version,
      input: {
        name,
        contentTemplate: '{bazis.order_id}',
        errorCorrection: 'H',
        defaultSizeMm: 30,
        idempotencyKey: `${namePrefix}-update-key`,
      },
    });

    expect(updated.version).toBe(2);
    expect(updated.contentTemplate).toBe('{bazis.order_id}');

    const audit = await sessionClient.query(
      `SELECT event FROM audit_log WHERE event = 'label_qr_template.updated' AND entity_id = $1`,
      [String(created.labelQrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('rejects an update with a stale version with a 409', async () => {
    const name = `${namePrefix} stale`;
    const created = await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-stale-create',
      input: {
        name,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-stale-create-key`,
      },
    });

    await expect(
      repo.updateQrTemplate({
        currentUser: currentUser(),
        requestId: 'req-stale-update',
        id: created.labelQrTemplateId,
        expectedVersion: created.version + 1,
        input: {
          name,
          contentTemplate: '{bazis.order_id}',
          errorCorrection: 'H',
          defaultSizeMm: 30,
          idempotencyKey: `${namePrefix}-stale-update-key`,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LABEL_QR_TEMPLATE_VERSION_STALE' });
  });

  it('deletes by soft-deactivating and audits the deletion', async () => {
    const name = `${namePrefix} delete`;
    const created = await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-delete-create',
      input: {
        name,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-delete-create-key`,
      },
    });

    await repo.deleteQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-delete-1',
      id: created.labelQrTemplateId,
      expectedVersion: created.version,
      idempotencyKey: `${namePrefix}-delete-key`,
    });

    const row = await sessionClient.query(
      'SELECT is_active, version FROM label_qr_templates WHERE label_qr_template_id = $1',
      [created.labelQrTemplateId],
    );
    expect(row.rows[0]).toMatchObject({ is_active: false, version: 2 });

    const audit = await sessionClient.query(
      `SELECT event FROM audit_log WHERE event = 'label_qr_template.deleted' AND entity_id = $1`,
      [String(created.labelQrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('lists active templates by default and includes inactive ones on request', async () => {
    const activeName = `${namePrefix} list-active`;
    const inactiveName = `${namePrefix} list-inactive`;

    const active = await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-list-active',
      input: {
        name: activeName,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-list-active-key`,
      },
    });

    const inactive = await repo.createQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-list-inactive-create',
      input: {
        name: inactiveName,
        contentTemplate: '{bazis.detail_id}',
        errorCorrection: 'M',
        defaultSizeMm: 20,
        idempotencyKey: `${namePrefix}-list-inactive-key`,
      },
    });
    await repo.deleteQrTemplate({
      currentUser: currentUser(),
      requestId: 'req-list-inactive-delete',
      id: inactive.labelQrTemplateId,
      expectedVersion: inactive.version,
      idempotencyKey: `${namePrefix}-list-inactive-delete-key`,
    });

    const defaultList = await repo.listQrTemplates({ currentUser: currentUser(), requestId: 'req-list-default' });
    expect(defaultList.some((t) => t.labelQrTemplateId === active.labelQrTemplateId)).toBe(true);
    expect(defaultList.some((t) => t.labelQrTemplateId === inactive.labelQrTemplateId)).toBe(false);

    const fullList = await repo.listQrTemplates({
      currentUser: currentUser(),
      requestId: 'req-list-all',
      includeInactive: true,
    });
    expect(fullList.some((t) => t.labelQrTemplateId === inactive.labelQrTemplateId)).toBe(true);
  });
});
