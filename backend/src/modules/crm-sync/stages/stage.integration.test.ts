import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { ConfigService } from '@nestjs/config';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { BackendEnv } from '../../../config/env.validation';
import { AuditService } from '../../../common/audit/audit.service';
import { BitrixAuditService } from '../../audit/application/bitrix-audit.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { StageRepository } from './stage-repository';
import { StageWorker } from './stage-worker';
import { StageAdminService } from './stage-admin.service';
import { normalizeStages } from './stage-policy';

// Explicit stage-only opt-in. Credentials stay in memory; isolated schema and
// all fixture writes/migrations are rolled back. No calls to a real Bitrix portal.
const optIn = process.env.ERP_STAGE_SQL_CANARY === 'true';
class FixtureDb extends DatabaseService {
  constructor(readonly client: PoolClient) {
    super(
      new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }),
      {} as never
    );
  }
  override query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    args: readonly unknown[] = []
  ) {
    return this.client.query<T>(sql, [...args]);
  }
  override async transaction<T>(
    fn: (tx: TransactionClient) => Promise<T>
  ): Promise<T> {
    await this.client.query('SAVEPOINT fixture');
    try {
      const v = await fn({ raw: this.client, query: this.query.bind(this) });
      await this.client.query('RELEASE SAVEPOINT fixture');
      return v;
    } catch (e) {
      await this.client.query('ROLLBACK TO SAVEPOINT fixture');
      throw e;
    }
  }
  override async withAdvisoryLock<T>(
    _key: string,
    fn: (prove: () => Promise<void>) => Promise<T>
  ) {
    return fn(async () => {});
  }
}
describe.skipIf(!optIn)('stages real PostgreSQL + stub Bitrix', () => {
  let pool: Pool,
    client: PoolClient,
    db: FixtureDb,
    repo: StageRepository,
    worker: StageWorker,
    admin: StageAdminService;
  let remote: Record<string, unknown>, failAfterWrite: boolean, robot: boolean;
  const actor = { id: '1', requestId: 'E2E-stage-request' };
  const rawStages = [
    { STATUS_ID: 'NEW', NAME: 'Новая', SORT: 10, SEMANTICS: '' },
    { STATUS_ID: 'WORK', NAME: 'Работа', SORT: 20, SEMANTICS: '' },
    { STATUS_ID: 'WON', NAME: 'Успех', SORT: 100, SEMANTICS: 'S' },
  ];
  let writes: ReturnType<typeof vi.fn>;
  let creates: ReturnType<typeof vi.fn>;
  let reads: ReturnType<typeof vi.fn>;
  let createResponseLost = false;
  beforeEach(async () => {
    rawStages.splice(3);
    createResponseLost = false;
    const raw = execFileSync(
      'docker',
      [
        'exec',
        'erp_test-backend-1',
        'node',
        '-e',
        'process.stdout.write(process.env.DATABASE_URL||"")',
      ],
      { encoding: 'utf8' }
    );
    const url = new URL(raw);
    const ip = execFileSync(
      'docker',
      [
        'inspect',
        'erp_test-postgresdb-1',
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}',
      ],
      { encoding: 'utf8' }
    )
      .trim()
      .split(' ')[0];
    url.hostname = ip;
    pool = new Pool({
      connectionString: url.href,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const schema = 'e2e_stages_' + randomUUID().replaceAll('-', '');
    await client.query(
      `CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema},public`
    );
    await client.query(`CREATE TABLE users(user_id bigint PRIMARY KEY); INSERT INTO users VALUES(1);
      CREATE TABLE order_statuses(order_status_id smallint PRIMARY KEY,order_status_name text,order_status_code text,color text,is_active boolean,sort_order int);
      INSERT INTO order_statuses VALUES(1,'Новый','new','#ffffff',true,10),(2,'В работе','work','#ffffff',true,20),(8,'Завершен','done','#ffffff',true,30);
      CREATE TABLE orders(order_id bigint PRIMARY KEY,order_name text,order_status_id smallint,order_kind text,delete_flag boolean DEFAULT false,client_id bigint DEFAULT 1,version int DEFAULT 1,edited_by bigint DEFAULT 1);
      CREATE TABLE bitrix24_app_installation(member_id text PRIMARY KEY,domain text,status text);INSERT INTO bitrix24_app_installation VALUES('E2E','example.invalid','active');
      CREATE TABLE crm_sync_mapping(entity_type text,erp_id text,bitrix_object text,bitrix_id text,status text,source_system text);
      CREATE TABLE bitrix24_incoming_request(bitrix_deal_id text,linked_order_id bigint,state text);
      CREATE TABLE audit_log(LIKE public.audit_log INCLUDING DEFAULTS);
      INSERT INTO orders(order_id,order_name,order_status_id,order_kind) VALUES(10,'E2E-Historical',1,'production_order');`);
    await client.query(
      readFileSync(
        new URL(
          '../../../../db/migrations/168_bitrix24_order_stages.sql',
          import.meta.url
        ),
        'utf8'
      )
    );
    await client.query(
      'INSERT INTO bitrix24_stage_catalog(member_id,category_id,category_name,stages) VALUES($1,0,$2,$3)',
      ['E2E', 'E2E funnel', JSON.stringify(normalizeStages(rawStages))]
    );
    await client.query(
      "UPDATE bitrix24_stage_config SET member_id='E2E',domain='example.invalid',category_id=0,completed_status_id=8,enabled=true,binding_locked=true"
    );
    await client.query(
      "INSERT INTO bitrix24_stage_mapping VALUES('E2E',0,1,'NEW',1,now()),('E2E',0,2,'WORK',1,now()),('E2E',0,8,'WON',1,now())"
    );
    db = new FixtureDb(client);
    repo = new StageRepository(db, new AuditService());
    remote = {
      id: 700,
      categoryId: 0,
      stageId: 'NEW',
      originatorId: 'MEBELKZ_ERP',
      originId: 'ORDER_11',
    };
    failAfterWrite = false;
    robot = false;
    writes = vi.fn(async (_id: string, stage: string) => {
      remote.stageId = robot ? 'NEW' : stage;
      if (failAfterWrite) {
        failAfterWrite = false;
        throw new Error('NETWORK_ERROR synthetic');
      }
    });
    let guard = async () => {};
    creates = vi.fn(async (fields: Record<string, unknown>) => {
      await guard();
      rawStages.push({
        STATUS_ID: String(fields.STATUS_ID),
        NAME: String(fields.NAME),
        SORT: Number(fields.SORT),
        SEMANTICS: '',
      });
      if (createResponseLost) {
        createResponseLost = false;
        throw new Error('NETWORK_ERROR synthetic create');
      }
    });
    reads = vi.fn(async () => {
      await guard();
      return { ...remote };
    });
    const bitrix = {
      createWorkingStage: creates,
      withRequestGuard: async (
        g: () => Promise<void>,
        fn: () => Promise<unknown>
      ) => {
        const prior = guard;
        guard = g;
        try {
          return await fn();
        } finally {
          guard = prior;
        }
      },
      getCrmItem: reads,
      updateDealStage: async (id: string, s: string) => {
        await guard();
        return writes(id, s);
      },
      listDealStages: async () => {
        await guard();
        return rawStages;
      },
      listDealCategories: async () => [{ id: 0, name: 'E2E funnel' }],
    };
    const runtime = {
      getFlags: () => ({
        enabled: true,
        dryRun: false,
        relayOwner: 'in_process',
        batchSize: 1,
        leaseMs: 60000,
        maxAttempts: 10,
      }),
      getReverseSync: () => ({
        enabled: true,
        dryRun: false,
        relayOwner: 'in_process',
        portalDomain: 'example.invalid',
      }),
      getBitrix24: () => ({ webhookUrl: 'https://example.invalid/rest/E2E' }),
    };
    worker = new StageWorker(repo, bitrix as never, runtime as never);
    admin = new StageAdminService(
      repo,
      bitrix as never,
      runtime as never,
      { getAccessToken: async () => 'synthetic' } as never,
      {
        currentUser: async () => ({ id: '1', active: true, admin: true }),
      } as never
    );
  });
  afterEach(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    await pool?.end();
  });
  it('queries stage and entity audit queues independently with actual PostgreSQL', async () => {
    await seed();
    await client.query(`ALTER TABLE crm_sync_mapping ADD COLUMN parent_erp_id text, ADD COLUMN last_error text;
      CREATE TABLE crm_sync_outbox(outbox_event_id bigint,event_type text,payload_json jsonb,aggregate_id text,status text,attempts int,created_at timestamptz,processed_at timestamptz,next_attempt_at timestamptz);
      CREATE TABLE bitrix24_inbound_event(status text,created_at timestamptz,processed_at timestamptz);
      INSERT INTO crm_sync_outbox VALUES(1,'crm.sync.order.upsert','{"entity":"order","id":"11"}', '11','pending',0,now(),null,now());`);
    const user: CurrentUser = {
      id: '1',
      username: 'E2E-audit',
      role: 'admin',
      roleId: 1,
      permissions: ['audit.view'],
    };
    const flags = () => ({
      enabled: true,
      relayOwner: 'in_process',
      dryRun: false,
    });
    const service = new BitrixAuditService(db, {
      getFlags: flags,
      getReverseSync: flags,
    } as never);
    const query = {
      direction: 'forward' as const,
      orderId: 11,
      page: 1,
      pageSize: 25,
    };
    expect((await service.queue(user, query)).pagination.total).toBe(2);
    const stage = await service.queue(user, {
      ...query,
      queueType: 'order_stage',
      bitrixId: '700',
    });
    expect(stage.data).toHaveLength(1);
    expect(stage.data[0]).toMatchObject({
      queueType: 'order_stage',
      orderId: '11',
      orderName: 'E2E-Order',
      bitrixId: '700',
      status: 'pending',
    });
    expect(
      (await service.queue(user, { ...query, queueType: 'entity' })).data
    ).toHaveLength(1);
    expect((await service.status(user)).stageQueue).toEqual([
      { status: 'pending', count: 1 },
    ]);
  });
  async function seed(kind = 'production_order') {
    await client.query(
      "INSERT INTO orders(order_id,order_name,order_status_id,order_kind) VALUES(11,'E2E-Order',2,$1)",
      [kind]
    );
    await client.query(
      "INSERT INTO crm_sync_mapping VALUES('order','11','deal','700','active','erp')"
    );
  }
  async function tick() {
    await client.query(
      "UPDATE bitrix24_stage_work SET next_attempt_at=now() WHERE status='pending'"
    );
    await worker.runLocked(async () => {});
  }
  async function state() {
    return (
      await client.query('SELECT * FROM bitrix24_stage_work WHERE order_id=11')
    ).rows[0];
  }
  it('does not enroll history; only status changes, inserts and conversion enqueue', async () => {
    expect(
      (await client.query('SELECT count(*)::int n FROM bitrix24_stage_work'))
        .rows[0].n
    ).toBe(0);
    await seed('crm_request');
    expect(await state()).toBeUndefined();
    await client.query(
      "SELECT set_config('app.crm_sync_origin','bitrix24',true)"
    );
    await client.query(
      "UPDATE orders SET order_kind='production_order' WHERE order_id=11"
    );
    expect((await state()).status).toBe('pending');
    const revision = (await state()).revision;
    await client.query(
      "UPDATE orders SET order_name='E2E-Renamed' WHERE order_id=11"
    );
    expect((await state()).revision).toBe(revision);
  });
  it('writes and audits once; duplicate echoes are no-op; observed drift restores', async () => {
    await seed();
    await tick();
    expect((await state()).status).toBe('processed');
    expect(writes).toHaveBeenCalledTimes(1);
    await repo.observe(db, 'E2E', '700', 0, 'WORK');
    await tick();
    expect(writes).toHaveBeenCalledTimes(1);
    remote.stageId = 'NEW';
    await repo.observe(db, 'E2E', '700', 0, 'NEW');
    await tick();
    expect(writes).toHaveBeenCalledTimes(2);
    expect(
      (
        await client.query(
          "SELECT event,related_order_id FROM audit_log WHERE event IN ('crm_sync.stage_sync_applied','crm_sync.stage_restored') ORDER BY audit_id"
        )
      ).rows
    ).toHaveLength(2);
  });
  it('recovers uncertain HTTP without a second write and audits verified receipt once', async () => {
    await seed();
    failAfterWrite = true;
    await tick();
    expect((await state()).status).toBe('pending');
    await tick();
    expect(writes).toHaveBeenCalledTimes(1);
    expect((await state()).status).toBe('processed');
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM bitrix24_stage_attempt WHERE state='verified'"
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('blocks before fourth restoration, then explicit retry resets breaker', async () => {
    await seed();
    await tick();
    for (let i = 0; i < 4; i++) {
      remote.stageId = 'NEW';
      await repo.observe(db, 'E2E', '700', 0, 'NEW');
      await tick();
    }
    expect(writes).toHaveBeenCalledTimes(4);
    expect((await state()).status).toBe('blocked');
    await admin.retry('11', actor);
    await tick();
    expect((await state()).status).toBe('processed');
  });
  it('blocks a robot that instantly reverts even before first successful initialization', async () => {
    await seed();
    robot = true;
    for (let i = 0; i < 4; i++) await tick();
    expect(writes).toHaveBeenCalledTimes(3);
    expect((await state()).status).toBe('blocked');
  });
  it('source revision invalidates stale worker, exact lease release preserves pending new status', async () => {
    await seed();
    const w = (await repo.claim(60000))!,
      c = await repo.config();
    await client.query('UPDATE orders SET order_status_id=8 WHERE order_id=11');
    await expect(repo.prove(w, c)).rejects.toThrow();
    await repo.finish(
      w,
      c,
      await repo.order('11'),
      'processed',
      null,
      'WORK',
      'WORK'
    );
    expect((await state()).status).toBe('pending');
    await tick();
    expect(remote.stageId).toBe('WON');
  });
  it('holds missing mapping, wakes on mapping insertion, rejects foreign category', async () => {
    await seed();
    await client.query('DELETE FROM crm_sync_mapping');
    await tick();
    expect((await state()).status).toBe('waiting_mapping');
    await client.query(
      "INSERT INTO crm_sync_mapping VALUES('order','11','deal','700','active','erp')"
    );
    expect((await state()).status).toBe('pending');
    remote.categoryId = 2;
    await tick();
    expect((await state()).status).toBe('blocked');
    expect(writes).not.toHaveBeenCalled();
  });
  it('can stop locally with an invalid catalog and inactive portal, preserving stored mappings', async () => {
    await seed();
    await client.query(
      "UPDATE bitrix24_app_installation SET status='inactive'; UPDATE bitrix24_stage_catalog SET stages='[]'"
    );
    const job = await admin.previewSettings(
      {
        version: 1,
        categoryId: 99,
        completedStatusId: 1,
        enabled: false,
        mappings: [],
      },
      actor
    );
    expect(job.payload.settings).toMatchObject({
      categoryId: 0,
      completedStatusId: 8,
      enabled: false,
    });
    expect(
      (job.payload.settings as { mappings: unknown[] }).mappings
    ).toHaveLength(3);
    await admin.applySettings(job.job_id, actor);
    expect((await repo.config()).enabled).toBe(false);
    expect((await state()).status).toBe('cancelled');
    expect(await repo.mappings(await repo.config())).toHaveLength(3);
    expect(writes).not.toHaveBeenCalled();
  });
  it('settings preview/apply disables and reenabling never revives old enrollment', async () => {
    await seed();
    const input = {
      version: 1,
      categoryId: 0,
      completedStatusId: 8,
      enabled: false,
      mappings: [
        { orderStatusId: 1, stageId: 'NEW' },
        { orderStatusId: 2, stageId: 'WORK' },
        { orderStatusId: 8, stageId: 'WON' },
      ],
    };
    const preview = await admin.previewSettings(input, actor);
    await admin.applySettings(preview.job_id, actor);
    expect((await state()).status).toBe('cancelled');
    const reenable = await admin.previewSettings(
      { ...input, version: 2, enabled: true },
      actor
    );
    await admin.applySettings(reenable.job_id, actor);
    await tick();
    expect(writes).not.toHaveBeenCalled();
    await client.query('UPDATE orders SET order_status_id=8 WHERE order_id=11');
    await tick();
    expect(remote.stageId).toBe('WON');
  });
  it('recovers deterministic stage creation after response loss and audits once', async () => {
    const job = await admin.previewProvision([2], actor);
    createResponseLost = true;
    await expect(admin.applyProvision(job.job_id, actor)).rejects.toThrow(
      'NETWORK_ERROR'
    );
    expect(creates).toHaveBeenCalledOnce();
    await admin.applyProvision(job.job_id, actor);
    await admin.applyProvision(job.job_id, actor);
    expect(creates).toHaveBeenCalledOnce();
    expect((await admin.job(job.job_id)).results['2']).toBe('Создана');
    expect(
      (
        await client.query(
          "SELECT count(*)::int n FROM audit_log WHERE event='crm_sync.stage_created'"
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('pages both directions and filters exact order identity without remote writes', async () => {
    await client.query(`INSERT INTO orders(order_id,order_name,order_status_id,order_kind,delete_flag) VALUES
      (20,'E2E-Target',1,'production_order',false),(30,'E2E-Target',1,'production_order',false),
      (40,'E2E-Target',1,'crm_request',false),(50,'E2E-Target',1,'production_order',true),
      (60,'E2E-Unlinked',1,'production_order',false),(70,'E2E-Target',1,'production_order',false);
      INSERT INTO crm_sync_mapping(entity_type,erp_id,bitrix_object,bitrix_id,status,source_system)
      SELECT 'order',order_id::text,'deal','700','active','erp' FROM orders WHERE order_id IN (20,30,40,50);
      INSERT INTO crm_sync_mapping VALUES('client','70','contact','700','active','erp');`);
    const first = await admin.previewReconcile(0, 1, actor, { sort: 'desc' });
    expect(first.payload.rows).toMatchObject([{ orderId: '30' }]);
    expect(first.payload).toMatchObject({
      hasMore: true,
      nextCursor: '30',
      selection: { sort: 'desc' },
    });
    const second = await admin.previewReconcile(30, 1, actor, { sort: 'desc' });
    expect(second.payload.rows).toMatchObject([{ orderId: '20' }]);
    expect(second.payload.hasMore).toBe(false);
    const old = await admin.previewReconcile(0, 1, actor);
    expect(old.payload.rows).toMatchObject([{ orderId: '20' }]);
    expect(
      (await admin.previewReconcile(20, 1, actor)).payload.rows
    ).toMatchObject([{ orderId: '30' }]);
    const exact = await admin.previewReconcile(0, 25, actor, {
      sort: 'desc',
      orderId: 20,
    });
    expect(exact.payload.rows).toMatchObject([{ orderId: '20' }]);
    expect(exact.payload.hasMore).toBe(false);
    const byName = await admin.previewReconcile(0, 25, actor, {
      sort: 'desc',
      orderName: 'E2E-Target',
    });
    expect(byName.payload.rows).toMatchObject([
      { orderId: '30' },
      { orderId: '20' },
    ]);
    expect(byName.payload.selection).toEqual({
      sort: 'desc',
      orderName: 'E2E-Target',
    });
    for (const orderName of ['E2E-Targ', 'E2E-Unlinked', "' OR true --", '%']) {
      const empty = await admin.previewReconcile(0, 25, actor, { orderName });
      expect(empty.payload.rows).toEqual([]);
      expect(empty.payload.hasMore).toBe(false);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(creates).not.toHaveBeenCalled();
  });
  it('bounds remote reads at 25 and finishes a full final page without a phantom next page', async () => {
    await client.query(`INSERT INTO orders(order_id,order_name,order_status_id,order_kind)
      SELECT i,'E2E-page-'||i,1,'production_order' FROM generate_series(100,149) i;
      INSERT INTO crm_sync_mapping(entity_type,erp_id,bitrix_object,bitrix_id,status,source_system)
      SELECT 'order',order_id::text,'deal','700','active','erp' FROM orders WHERE order_id>=100;`);
    const first = await admin.previewReconcile(0, 25, actor, { sort: 'desc' });
    expect(first.payload.rows).toHaveLength(25);
    expect(first.payload).toMatchObject({ nextCursor: '125', hasMore: true });
    expect(reads).toHaveBeenCalledTimes(25);
    const second = await admin.previewReconcile(125, 25, actor, {
      sort: 'desc',
    });
    expect(second.payload.rows).toHaveLength(25);
    expect(second.payload).toMatchObject({ nextCursor: '100', hasMore: false });
    expect(reads).toHaveBeenCalledTimes(50);
    expect(writes).not.toHaveBeenCalled();
  });
  it('refuses stale selected preview and changed portal installation before writes', async () => {
    await seed();
    await tick();
    const job = await admin.previewReconcile(10, 25, actor);
    await client.query('UPDATE orders SET version=version+1 WHERE order_id=11');
    const result = await admin.applyReconcile(job.job_id, ['11'], actor);
    expect(result.results['11']).toBe('Предпросмотр устарел');
    await client.query(
      "UPDATE bitrix24_app_installation SET status='inactive'"
    );
    await expect(admin.previewReconcile(10, 25, actor)).rejects.toThrow();
    expect(writes).toHaveBeenCalledOnce();
  });
  it('enrolls only selected unchanged preview and stores durable per-row results', async () => {
    await seed();
    await tick();
    const preview = await admin.previewReconcile(10, 25, actor);
    await admin.applyReconcile(preview.job_id, ['11'], actor);
    await tick();
    expect((await admin.job(preview.job_id)).results['11']).toBe('Выполнено');
    expect(writes).toHaveBeenCalledTimes(1);
  });
});
