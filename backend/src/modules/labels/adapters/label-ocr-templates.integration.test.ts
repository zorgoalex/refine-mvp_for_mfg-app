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
const schemaName = `labels_ocr_tpl_${randomUUID().replaceAll('-', '_')}`;
const namePrefix = `Тест OCR ${Date.now()}`;

const migrationLabelOcrTemplates = readFileSync(new URL('../../../../db/migrations/053_label_ocr_templates.sql', import.meta.url), 'utf8');

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

const sampleRules = [{ field: 'order_number' as const, sampleText: 'ФК123', anchor: null }];

describeIntegration('PgLabelsRepository OCR templates (integration)', () => {
  let pool: Pool;
  let sessionClient: PoolClient;
  let repo: PgLabelsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    sessionClient = await pool.connect();
    await sessionClient.query(`CREATE SCHEMA ${schemaName}`);
    await sessionClient.query(`SET search_path TO ${schemaName}`);
    await createPrerequisites(sessionClient);
    await sessionClient.query(migrationLabelOcrTemplates);
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

  it('creates an OCR template with an audit row carrying fieldCodes/metadata', async () => {
    const name = `${namePrefix} create`;
    const created = await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-ocr-create',
      input: {
        name,
        rules: sampleRules,
        sampleLines: ['ФК123 100x200'],
        isActive: true,
        idempotencyKey: `${namePrefix}-create-key`,
      },
    });

    expect(created.version).toBe(1);
    expect(created.isActive).toBe(true);
    expect(created.name).toBe(name);
    expect(created.rules).toEqual(sampleRules);

    const row = await sessionClient.query(
      'SELECT name, is_active, version FROM label_ocr_templates WHERE label_ocr_template_id = $1',
      [created.labelOcrTemplateId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({ name, is_active: true, version: 1 });

    const audit = await sessionClient.query(
      `SELECT event, user_id, entity_id, after_json, metadata_json FROM audit_log
        WHERE event = 'label_ocr_template.created' AND entity_id = $1`,
      [String(created.labelOcrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].user_id).toBe('7');
    expect(audit.rows[0].after_json.fieldCodes).toEqual(['order_number']);
    expect(audit.rows[0].metadata_json).toMatchObject({ idempotencyKey: `${namePrefix}-create-key` });
  });

  it('rejects an update with a stale version, then updates + audits with correct version', async () => {
    const name = `${namePrefix} update`;
    const created = await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-update-create',
      input: {
        name,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-update-create-key`,
      },
    });

    await expect(
      repo.updateOcrTemplate({
        currentUser: currentUser(),
        requestId: 'req-update-stale',
        id: created.labelOcrTemplateId,
        expectedVersion: created.version + 1,
        input: {
          name,
          rules: sampleRules,
          sampleLines: [],
          isActive: true,
          idempotencyKey: `${namePrefix}-update-stale-key`,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LABEL_OCR_TEMPLATE_VERSION_STALE' });

    const updatedRules = [{ field: 'detail_number' as const, sampleText: '5', anchor: null }];
    const updated = await repo.updateOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-update-1',
      id: created.labelOcrTemplateId,
      expectedVersion: created.version,
      input: {
        name,
        rules: updatedRules,
        sampleLines: ['5 шт'],
        isActive: true,
        idempotencyKey: `${namePrefix}-update-key`,
      },
    });

    expect(updated.version).toBe(2);
    expect(updated.rules).toEqual(updatedRules);

    const audit = await sessionClient.query(
      `SELECT diff_json FROM audit_log WHERE event = 'label_ocr_template.updated' AND entity_id = $1`,
      [String(created.labelOcrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].diff_json.fieldCodes).toEqual(['detail_number']);
  });

  it('reactivates a deleted template via update(isActive:true) and audits the change', async () => {
    const name = `${namePrefix} reactivate`;
    const created = await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-reactivate-create',
      input: {
        name,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-reactivate-create-key`,
      },
    });

    await repo.deleteOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-reactivate-delete',
      id: created.labelOcrTemplateId,
      expectedVersion: created.version,
      idempotencyKey: `${namePrefix}-reactivate-delete-key`,
    });

    const deletedRow = await sessionClient.query(
      'SELECT is_active, version FROM label_ocr_templates WHERE label_ocr_template_id = $1',
      [created.labelOcrTemplateId],
    );
    expect(deletedRow.rows[0]).toMatchObject({ is_active: false, version: 2 });

    const reactivated = await repo.updateOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-reactivate-update',
      id: created.labelOcrTemplateId,
      expectedVersion: 2,
      input: {
        name,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-reactivate-update-key`,
      },
    });

    expect(reactivated.isActive).toBe(true);
    expect(reactivated.version).toBe(3);

    const row = await sessionClient.query(
      'SELECT is_active, version FROM label_ocr_templates WHERE label_ocr_template_id = $1',
      [created.labelOcrTemplateId],
    );
    expect(row.rows[0]).toMatchObject({ is_active: true, version: 3 });

    const audit = await sessionClient.query(
      `SELECT after_json, diff_json FROM audit_log
        WHERE event = 'label_ocr_template.updated' AND entity_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [String(created.labelOcrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after_json.isActive).toBe(true);
    expect(audit.rows[0].diff_json.isActive).toBe(true);
  });

  it('deletes by soft-deactivating and audits the deletion', async () => {
    const name = `${namePrefix} delete`;
    const created = await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-delete-create',
      input: {
        name,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-delete-create-key`,
      },
    });

    await repo.deleteOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-delete-1',
      id: created.labelOcrTemplateId,
      expectedVersion: created.version,
      idempotencyKey: `${namePrefix}-delete-key`,
    });

    const row = await sessionClient.query(
      'SELECT is_active, version FROM label_ocr_templates WHERE label_ocr_template_id = $1',
      [created.labelOcrTemplateId],
    );
    expect(row.rows[0]).toMatchObject({ is_active: false, version: 2 });

    const audit = await sessionClient.query(
      `SELECT event FROM audit_log WHERE event = 'label_ocr_template.deleted' AND entity_id = $1`,
      [String(created.labelOcrTemplateId)],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('records a denied-permission audit event with the label_ocr_template event name', async () => {
    await repo.recordPermissionDenied({
      currentUser: currentUser(),
      requiredPermissions: ['labels.manage_templates'],
      requestId: 'req-denied-1',
      targetEntityType: 'label_ocr_template',
      targetId: 999999,
    });

    const audit = await sessionClient.query(
      `SELECT event, entity_type, entity_id FROM audit_log
        WHERE event = 'label_ocr_template.permission_denied' AND entity_id = $1`,
      ['999999'],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].entity_type).toBe('label_ocr_template');

    const notLabelTemplate = await sessionClient.query(
      `SELECT event FROM audit_log WHERE event = 'label_template.permission_denied' AND entity_id = $1`,
      ['999999'],
    );
    expect(notLabelTemplate.rows).toHaveLength(0);
  });

  it('listActiveOcrTemplatesForMatch returns only active rows with rules parsed as an array', async () => {
    const activeName = `${namePrefix} match-active`;
    const inactiveName = `${namePrefix} match-inactive`;

    const active = await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-match-active',
      input: {
        name: activeName,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-match-active-key`,
      },
    });

    const inactive = await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-match-inactive-create',
      input: {
        name: inactiveName,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-match-inactive-key`,
      },
    });
    await repo.deleteOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-match-inactive-delete',
      id: inactive.labelOcrTemplateId,
      expectedVersion: inactive.version,
      idempotencyKey: `${namePrefix}-match-inactive-delete-key`,
    });

    const forMatch = await repo.listActiveOcrTemplatesForMatch();
    const activeEntry = forMatch.find((t) => t.id === active.labelOcrTemplateId);
    expect(activeEntry).toBeDefined();
    expect(Array.isArray(activeEntry?.rules)).toBe(true);
    expect(activeEntry?.rules[0]).toMatchObject({ field: 'order_number' });
    expect(forMatch.some((t) => t.id === inactive.labelOcrTemplateId)).toBe(false);
  });

  it('rejects creating a second active template with the same name (case-insensitive)', async () => {
    const name = `${namePrefix} dup`;
    await repo.createOcrTemplate({
      currentUser: currentUser(),
      requestId: 'req-dup-1',
      input: {
        name,
        rules: sampleRules,
        sampleLines: [],
        isActive: true,
        idempotencyKey: `${namePrefix}-dup-key-1`,
      },
    });

    await expect(
      repo.createOcrTemplate({
        currentUser: currentUser(),
        requestId: 'req-dup-2',
        input: {
          name: name.toUpperCase(),
          rules: sampleRules,
          sampleLines: [],
          isActive: true,
          idempotencyKey: `${namePrefix}-dup-key-2`,
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'LABEL_OCR_TEMPLATE_NAME_TAKEN' });
  });
});
