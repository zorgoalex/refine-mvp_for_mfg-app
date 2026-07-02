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
const schemaName = `labels_qr_${randomUUID().replaceAll('-', '_')}`;

const migration039 = readFileSync(new URL('../../../../db/migrations/039_labels.sql', import.meta.url), 'utf8');
const migration047 = readFileSync(new URL('../../../../db/migrations/047_label_template_qr_kind.sql', import.meta.url), 'utf8');

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

    CREATE TABLE orders (
      order_id BIGINT PRIMARY KEY,
      delete_flag BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE order_details (
      detail_id BIGINT PRIMARY KEY,
      order_id BIGINT REFERENCES orders(order_id) ON DELETE CASCADE
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

describeIntegration('PgLabelsRepository qr kind roundtrip (integration)', () => {
  let pool: Pool;
  let sessionClient: PoolClient;
  let repo: PgLabelsRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    sessionClient = await pool.connect();
    await sessionClient.query(`CREATE SCHEMA ${schemaName}`);
    await sessionClient.query(`SET search_path TO ${schemaName}`);
    await createPrerequisites(sessionClient);
    await sessionClient.query(migration039);
    await sessionClient.query(migration047);
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

  it('persists and reloads qr template elements', async () => {
    const created = await repo.createTemplate({
      currentUser: currentUser(),
      requestId: 'req-qr-create',
      input: {
        name: 'QR Template',
        description: 'Roundtrip qr element',
        canvasWidthMm: 84,
        canvasHeightMm: 55,
        dpi: 203,
        defaultExportFormats: ['bmp'],
        customFieldSchema: {},
        elements: [
          {
            elementKey: 'qr-1',
            kind: 'qr',
            xMm: 1,
            yMm: 2,
            widthMm: 20,
            heightMm: 20,
            style: {
              qrTemplate: '{bazis.detail_id}',
              qrErrorCorrection: 'M',
            },
          },
        ],
        idempotencyKey: 'label-template-qr-roundtrip',
      },
    });

    const reread = await repo.getTemplateById({
      currentUser: currentUser(),
      requestId: 'req-qr-read',
      id: created.labelTemplateId,
    });

    expect(reread.elements).toHaveLength(1);
    expect(reread.elements[0]).toMatchObject({
      kind: 'qr',
      style: {
        qrTemplate: '{bazis.detail_id}',
        qrErrorCorrection: 'M',
      },
    });
  });
});
