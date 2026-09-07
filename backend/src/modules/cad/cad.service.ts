import { createHash, randomUUID } from 'node:crypto';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { DatabaseService } from '../../database/database.service';
import type { DatabaseClient, TransactionClient } from '../../database/database.types';
import { ApiError } from '../../common/errors/api-error';
import { auditService } from '../../common/audit/audit.service';
import type { CurrentUser } from '../../permissions/current-user';
import type { PermissionName } from '../../permissions/permissions';
import { OrderQueryService } from '../orders/application/order-query.service';
import { PgOrderReadRepository } from '../orders/adapters/pg-order-read-repository';
import { CadDocumentError, applyVariantChanges, cloneVariant, createGroups, refreshVariant, validateComposition,
  type CadGroup, type CadRecipeRef, type CadSourceSnapshot, type CadVariant } from '../../shared/cad-workspace';
import type { CadJob } from '../../shared/cad-api';
import { CadClient } from './cad-client';

interface RunRow {
  id: string; variant_id: string; revision: number; payload: unknown; actor: CurrentUser; request_id: string;
  remote_job_id: string | null; status: CadJob['status']; last_error: string | null; package_id: string | null; package_requested: boolean; attempts: number;
  package_actor: CurrentUser | null; package_request_id: string | null;
}

export class CadService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  constructor(private readonly database: DatabaseService, readonly client: CadClient, readonly enabled: boolean) {}
  onModuleInit() { if (this.enabled) this.schedule(); }
  onModuleDestroy() { this.stopping = true; if (this.timer) clearTimeout(this.timer); }
  private schedule() {
    this.timer = setTimeout(() => { void this.tick().catch(() => undefined).finally(() => { if (!this.stopping) this.schedule(); }); }, 2000);
    this.timer.unref();
  }
  require(user: CurrentUser, permission: PermissionName) {
    if (!this.enabled) throw new ApiError(503, 'CAD_DISABLED', 'CAD preparation is disabled');
    if (!user.permissions.includes(permission) || !user.permissions.includes('orders.view')) throw new ApiError(403, 'PERMISSION_DENIED', 'CAD permission required');
  }
  private async access(db: DatabaseClient, user: CurrentUser, orderIds: number[]) {
    const orders = new OrderQueryService({ reader: new PgOrderReadRepository(db, true) });
    for (const orderId of new Set(orderIds)) await orders.getById({ currentUser: user, orderId });
  }
  private async variant(db: DatabaseClient, user: CurrentUser, id: string, lock = false): Promise<CadVariant> {
    const row = await db.query<{ data: CadVariant }>(`SELECT data FROM cad_variants WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
    const value = row.rows[0]?.data;
    if (!value) throw new ApiError(404, 'CAD_VARIANT_NOT_FOUND', 'Variant not found');
    await this.access(db, user, value.sources.map(s => s.orderId));
    return value;
  }
  private async event(db: DatabaseClient, user: CurrentUser, requestId: string, event: string, variant: CadVariant | null, entityId: string,
    metadata: Record<string, unknown> = {}, runId: string | null = null, capturedSources: CadSourceSnapshot[] = []) {
    const sources = variant?.sources ?? capturedSources;
    const relatedParts = (source: CadSourceSnapshot) => variant
      ? source.parts.filter(p => variant.groups.some(g => g.orderId === source.orderId && g.detailId === p.detailId))
      : source.parts;
    const auditId = await auditService.record(db, { event, entityType: variant ? 'cad_variant' : capturedSources.length ? 'cad_source' : 'cad_mapping', entityId,
      actorUserId: user.id, actorUsername: user.username, actorRole: user.role, requestId, source: 'backend',
      relatedOrderId: sources[0]?.orderId, metadata, statusCode: event.split('.').at(-1),
      relatedEntities: sources.flatMap(s => [{ entityType: 'order', entityId: s.orderId }, ...relatedParts(s).map(p => ({ entityType: 'order_detail', entityId: p.detailId }))]),
    });
    const id = randomUUID();
    await db.query(`INSERT INTO cad_events(id,event,entity_id,variant_id,run_id,actor_id,request_id,audit_id,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [id, event, entityId, variant?.id ?? null, runId, user.id, requestId, auditId || null, JSON.stringify(metadata)]);
    for (const s of sources) {
      await db.query(`INSERT INTO cad_event_sources(event_id,order_id,detail_id) SELECT $1,$2,unnest($3::bigint[]) ON CONFLICT DO NOTHING`,
        [id, s.orderId, relatedParts(s).length ? relatedParts(s).map(p => p.detailId) : [0]]);
    }
  }
  private async mutate<T>(user: CurrentUser, key: string, operation: string, body: unknown, work: (db: TransactionClient) => Promise<T>): Promise<T> {
    if (!key || key.length > 200) throw new ApiError(422, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency key required');
    const hash = createHash('sha256').update(JSON.stringify({ operation, body })).digest('hex');
    return this.database.transaction(async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cad-command:${user.id}:${key}`]);
      const previous = await db.query<{ request_hash: string; result: T; access_order_ids: string[] }>('SELECT request_hash,result,access_order_ids FROM cad_commands WHERE actor_id=$1 AND idempotency_key=$2', [user.id, key]);
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== hash) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency body changed');
        await this.access(db, user, previous.rows[0].access_order_ids.map(Number));
        return previous.rows[0].result;
      }
      const result = await work(db);
      await db.query(`INSERT INTO cad_commands(actor_id,idempotency_key,request_hash,result,access_order_ids)
        VALUES($1,$2,$3,$4::jsonb,ARRAY(SELECT DISTINCT s.order_id FROM cad_event_sources s
          JOIN cad_events e ON e.id=s.event_id WHERE e.actor_id=$1 AND e.request_id=$2))`, [user.id, key, hash, JSON.stringify(result)]);
      return result;
    }).catch((error: unknown) => {
      if (error instanceof CadDocumentError) throw new ApiError(error.code === 'CAD_STALE_VERSION' ? 409 : 422, error.code, error.message, { issues: error.issues });
      if (error && typeof error === 'object' && 'code' in error && ['40001', '40P01'].includes(String(error.code))) throw new ApiError(409, 'CAD_CONCURRENT_CHANGE', 'Concurrent change; reload and retry');
      throw error;
    });
  }
  private async insertVariant(db: DatabaseClient, variant: CadVariant) {
    await db.query('INSERT INTO cad_variants(id,workspace_id,kind,revision,data) VALUES($1,$2,$3,$4,$5::jsonb)', [variant.id, variant.workspaceId, variant.kind, variant.version, JSON.stringify(variant)]);
    await db.query('INSERT INTO cad_variant_revisions VALUES($1,$2,$3::jsonb)', [variant.id, variant.version, JSON.stringify(variant)]);
  }
  private async capture(db: DatabaseClient, user: CurrentUser, orderId: number, persist = true): Promise<CadSourceSnapshot> {
    const order = await new OrderQueryService({ reader: new PgOrderReadRepository(db, true) }).getById({ currentUser: user, orderId });
    if (persist && order.details.length > 500) throw new ApiError(422, 'CAD_ORDER_SIZE', 'Expected at most 500 positions');
    const refs = await db.query<{ detail_id: string; thickness_mm: string | null; milling_name: string; edge_name: string; recipe: CadRecipeRef | null }>(`
      SELECT od.detail_id, smt.thickness_mm, mt.milling_type_name AS milling_name, et.edge_type_name AS edge_name, cm.recipe
      FROM order_details od LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id=od.sheet_material_type_id
      LEFT JOIN milling_types mt ON mt.milling_type_id=od.milling_type_id
      LEFT JOIN edge_types et ON et.edge_type_id=od.edge_type_id
      LEFT JOIN cad_recipe_mappings cm ON cm.milling_type_id=od.milling_type_id WHERE od.order_id=$1`, [orderId]);
    const byId = new Map(refs.rows.map(r => [Number(r.detail_id), r]));
    const snapshot: CadSourceSnapshot = { id: randomUUID(), orderId, orderName: order.header.orderName, capturedAt: new Date().toISOString(),
      parts: order.details.map(p => { const r = byId.get(p.id); return { orderId, detailId: p.id, detailNumber: p.detailNumber ?? 0,
        widthMm: p.width, heightMm: p.height, quantity: p.quantity, thicknessMm: r?.thickness_mm == null ? null : Number(r.thickness_mm),
        material: p.materialName ?? null, millingTypeId: p.millingTypeId, millingName: r?.milling_name ?? '', edgeName: r?.edge_name ?? '', recipe: r?.recipe ?? null }; }),
    };
    if (persist) await db.query('INSERT INTO cad_sources(id,order_id,data) VALUES($1,$2,$3::jsonb)', [snapshot.id, orderId, JSON.stringify(snapshot)]);
    return snapshot;
  }
  private async enqueue(db: DatabaseClient, user: CurrentUser, key: string, variant: CadVariant) {
    const existing = await db.query<{ id: string }>('SELECT id FROM cad_runs WHERE variant_id=$1 AND revision=$2', [variant.id, variant.version]);
    if (existing.rows[0]) return existing.rows[0].id;
    const id = randomUUID();
    const parts = variant.groups.map(g => {
      const source = variant.sources.find(s => s.id === g.sourceSnapshotId);
      const part = source?.parts.find(p => p.detailId === g.detailId);
      return { part_id: g.id, side: 'front', width_mm: part?.widthMm, height_mm: part?.heightMm, quantity: g.quantity,
        material: part?.material, thickness_mm: part?.thicknessMm, recipe: g.recipe,
        metadata: { workspaceId: variant.workspaceId, variantId: variant.id, revision: variant.version,
          orderId: g.orderId, detailId: g.detailId, sourceSnapshotId: g.sourceSnapshotId, originalRecipe: part?.recipe ?? null, edgeType: part?.edgeName ?? '', excludedOperations: ['obkat'] } };
    });
    await db.query('INSERT INTO cad_runs(id,variant_id,revision,payload,actor,request_id) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)',
      [id, variant.id, variant.version, JSON.stringify({ units: 'mm', parts, formats: ['svg', 'dxf'] }), JSON.stringify(user), key]);
    await this.event(db, user, key, 'cad.render.requested', variant, id, { revision: variant.version }, id);
    return id;
  }
  async workspace(user: CurrentUser, orderId: number) {
    this.require(user, 'cad.view');
    await this.access(this.database, user, [orderId]);
    const work = await this.database.query<{ id: string }>('SELECT id FROM cad_workspaces WHERE order_id=$1', [orderId]);
    if (!work.rows[0]) return { workspaceId: null, variants: [] };
    const variants = await this.database.query<{ data: CadVariant }>('SELECT data FROM cad_variants WHERE workspace_id=$1 ORDER BY created_at,id', [work.rows[0].id]);
    for (const row of variants.rows) await this.access(this.database, user, row.data.sources.map(s => s.orderId));
    return { workspaceId: work.rows[0].id, variants: variants.rows.map(r => r.data) };
  }
  async create(user: CurrentUser, orderId: number, key: string) {
    this.require(user, 'cad.edit'); await this.access(this.database, user, [orderId]); await this.client.capabilities();
    return this.mutate(user, key, 'create', { orderId }, async db => {
      await db.query('SELECT pg_advisory_xact_lock($1,$2)', [151, orderId]);
      const prior = await db.query<{ id: string }>('SELECT id FROM cad_workspaces WHERE order_id=$1', [orderId]);
      if (prior.rows[0]) return { workspaceId: prior.rows[0].id };
      const source = await this.capture(db, user, orderId), workspaceId = randomUUID();
      if (!source.parts.length) throw new ApiError(422, 'CAD_ORDER_EMPTY', 'Order has no rectangular positions');
      await db.query('INSERT INTO cad_workspaces(id,order_id) VALUES($1,$2)', [workspaceId, orderId]);
      const original: CadVariant = { id: randomUUID(), workspaceId, name: 'Оригинал', kind: 'original', version: 1, sources: [source],
        groups: createGroups([source], randomUUID), createdAt: new Date().toISOString(), parentId: null, jobId: null, renderRevision: null };
      await this.insertVariant(db, original);
      const working = cloneVariant(original, randomUUID(), 'Рабочая 1', new Date().toISOString());
      await this.insertVariant(db, working);
      await this.event(db, user, key, 'cad.workspace.created', original, workspaceId);
      await this.enqueue(db, user, key, original); await this.enqueue(db, user, key, working);
      return { workspaceId };
    });
  }
  async source(user: CurrentUser, orderId: number, key: string) {
    this.require(user, 'cad.edit'); await this.access(this.database, user, [orderId]);
    return this.mutate(user, key, 'source', { orderId }, async db => {
      const source = await this.capture(db, user, orderId);
      await this.event(db, user, key, 'cad.source.captured', null, source.id, { orderId }, null, [source]);
      return source;
    });
  }
  async save(user: CurrentUser, id: string, version: number, groups: CadGroup[], sourceIds: string[], key: string) {
    this.require(user, 'cad.edit'); await this.variant(this.database, user, id);
    const sourceRows = await this.database.query<{ data: CadSourceSnapshot }>('SELECT data FROM cad_sources WHERE id=ANY($1::uuid[])', [sourceIds]);
    if (sourceRows.rows.length !== new Set(sourceIds).size) throw new ApiError(422, 'SOURCE_NOT_FOUND', 'Unknown source');
    const sources = sourceRows.rows.map(r => r.data); await this.access(this.database, user, sources.map(s => s.orderId));
    return this.mutate(user, key, 'save', { id, version, groups, sourceIds }, async db => {
      const before = await this.variant(db, user, id, true);
      const next = applyVariantChanges(before, version, groups, sources);
      await db.query('UPDATE cad_variants SET revision=$2,data=$3::jsonb WHERE id=$1', [id, next.version, JSON.stringify(next)]);
      await db.query('INSERT INTO cad_variant_revisions VALUES($1,$2,$3::jsonb)', [id, next.version, JSON.stringify(next)]);
      await this.event(db, user, key, 'cad.variant.saved', next, id, { before: before.groups, after: next.groups, revision: next.version });
      return next;
    });
  }
  async clone(user: CurrentUser, id: string, name: string, refresh: boolean, key: string) {
    this.require(user, 'cad.edit'); await this.variant(this.database, user, id);
    return this.mutate(user, key, refresh ? 'refresh' : 'clone', { id, name }, async db => {
      const previous = await this.variant(db, user, id, true);
      const now = new Date().toISOString();
      const next = refresh
        ? refreshVariant(previous, await Promise.all(previous.sources.map(s => this.capture(db, user, s.orderId))), randomUUID(), name, now).variant
        : cloneVariant(previous, randomUUID(), name, now);
      await this.insertVariant(db, next);
      await this.event(db, user, key, refresh ? 'cad.variant.refreshed' : 'cad.variant.created', next, next.id, { parentId: previous.id, conflicts: validateComposition(next.groups, next.sources) });
      return next;
    });
  }
  async render(user: CurrentUser, id: string, version: number, key: string) {
    this.require(user, 'cad.edit'); await this.variant(this.database, user, id); await this.client.capabilities();
    return this.mutate(user, key, 'render', { id, version }, async db => {
      const variant = await this.variant(db, user, id, true);
      if (variant.version !== version) throw new ApiError(409, 'CAD_STALE_VERSION', 'Variant changed');
      const issues = validateComposition(variant.groups, variant.sources);
      if (issues.length) throw new ApiError(422, 'CAD_COMPOSITION_INVALID', 'Resolve composition conflicts', { issues });
      return { runId: await this.enqueue(db, user, key, variant) };
    });
  }
  async run(user: CurrentUser, id: string, revision: number) {
    this.require(user, 'cad.view'); await this.revision(this.database, user, id, revision);
    const row = await this.database.query<RunRow>('SELECT * FROM cad_runs WHERE variant_id=$1 AND revision=$2', [id, revision]);
    const run = row.rows[0];
    if (!run) return { run: null, job: null };
    // Archived revisions can reference orders removed from the current working version.
    await this.checkRunSources(user, run);
    const job = run.remote_job_id ? await this.client.job(run.remote_job_id, ['queued', 'running'].includes(run.status)) : null;
    return { run: { id: run.id, status: run.status, lastError: run.last_error, packageId: run.package_id, packageRequested: run.package_requested }, job };
  }
  private async checkRunSources(user: CurrentUser, run: RunRow) {
    return this.revision(this.database, user, run.variant_id, run.revision);
  }
  private async revision(db: DatabaseClient, user: CurrentUser, id: string, revision: number): Promise<CadVariant> {
    const stored = await db.query<{ data: CadVariant }>('SELECT data FROM cad_variant_revisions WHERE variant_id=$1 AND revision=$2', [id, revision]);
    if (!stored.rows[0]) throw new ApiError(404, 'CAD_REVISION_NOT_FOUND', 'Revision not found');
    await this.access(db, user, stored.rows[0].data.sources.map(s => s.orderId));
    return stored.rows[0].data;
  }
  async requestPackage(user: CurrentUser, id: string, revision: number, key: string) {
    this.require(user, 'cad.export'); const archived = await this.revision(this.database, user, id, revision);
    const selected = await this.database.query<RunRow>('SELECT * FROM cad_runs WHERE variant_id=$1 AND revision=$2', [id, revision]);
    const run = selected.rows[0];
    if (!run || run.status !== 'succeeded') throw new ApiError(409, 'CAD_RENDER_REQUIRED', 'Complete render required');
    await this.checkRunSources(user, run);
    return this.mutate(user, key, 'package', { id, revision }, async db => {
      const locked = await db.query<RunRow>('SELECT * FROM cad_runs WHERE id=$1 FOR UPDATE', [run.id]);
      const current = locked.rows[0];
      if (current.package_requested && !current.package_id) throw new ApiError(409, 'CAD_PACKAGE_PENDING', 'Package request already running');
      await db.query(`UPDATE cad_runs SET package_requested=true,package_actor=$2::jsonb,package_request_id=$3,
        attempts=0,last_error=NULL,next_attempt_at=now() WHERE id=$1`, [run.id, JSON.stringify(user), key]);
      await this.event(db, user, key, 'cad.package.requested', archived, run.id, { revision }, run.id);
      if (current.package_id) await this.event(db, user, key, 'cad.package.completed', archived, run.id, { artifactId: current.package_id, reused: true }, run.id);
      return { runId: run.id };
    });
  }
  async download(user: CurrentUser, runId: string, artifactId: string) {
    this.require(user, 'cad.export');
    const rows = await this.database.query<RunRow>('SELECT * FROM cad_runs WHERE id=$1', [runId]); const run = rows.rows[0];
    if (!run) throw new ApiError(404, 'CAD_RUN_NOT_FOUND', 'Run not found');
    await this.checkRunSources(user, run);
    // Production exports only after package eligibility has been checked by CAD.
    if (!run.package_id || !run.remote_job_id) throw new ApiError(409, 'CAD_PACKAGE_REQUIRED', 'Approved package required');
    const job = await this.client.job(run.remote_job_id);
    if (artifactId !== run.package_id && !job.package_files.some(f => f.id === artifactId) && !job.items.some(i => i.result?.files?.some(f => f.id === artifactId))) throw new ApiError(404, 'ARTIFACT_NOT_FOUND', 'Artifact not in selected revision');
    return this.client.artifact(artifactId);
  }
  async mappings(user: CurrentUser) {
    this.require(user, 'cad.view');
    return (await this.database.query('SELECT mt.milling_type_id,mt.milling_type_name,m.recipe,m.revision FROM milling_types mt LEFT JOIN cad_recipe_mappings m USING(milling_type_id) ORDER BY mt.milling_type_name')).rows;
  }
  async sourceStatus(user: CurrentUser, id: string) {
    this.require(user, 'cad.view');
    return this.database.transaction(async db => {
      await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const variant = await this.variant(db, user, id);
      const status = [];
      for (const source of variant.sources) {
        const fresh = await this.capture(db, user, source.orderId, false);
        const oldParts = new Map(source.parts.map(p => [p.detailId, p]));
        const freshParts = new Map(fresh.parts.map(p => [p.detailId, p]));
        const changes = [...new Set([...oldParts.keys(), ...freshParts.keys()])].filter(detailId => JSON.stringify(oldParts.get(detailId)) !== JSON.stringify(freshParts.get(detailId)));
        status.push({ orderId: source.orderId, stale: changes.length > 0 || source.orderName !== fresh.orderName, changedDetailIds: changes });
      }
      return status;
    });
  }
  async mapRecipe(user: CurrentUser, millingTypeId: number, recipe: CadRecipeRef, revision: number, key: string) {
    this.require(user, 'references.manage');
    const catalog = await this.client.catalog();
    if (!catalog.recipes.some(r => r.code === recipe.code && r.version === recipe.version && r.status === 'production') || Object.keys(recipe.parameters).length) throw new ApiError(422, 'CAD_APPROVED_RECIPE_REQUIRED', 'Choose approved default recipe version');
    return this.mutate(user, key, 'mapping', { millingTypeId, recipe, revision }, async db => {
      await db.query('SELECT pg_advisory_xact_lock($1,$2)', [152, millingTypeId]);
      const old = await db.query<{ revision: number; recipe: CadRecipeRef }>('SELECT revision,recipe FROM cad_recipe_mappings WHERE milling_type_id=$1 FOR UPDATE', [millingTypeId]);
      if ((old.rows[0]?.revision ?? 0) !== revision) throw new ApiError(409, 'CAD_STALE_VERSION', 'Mapping changed');
      await db.query(`INSERT INTO cad_recipe_mappings(milling_type_id,recipe) VALUES($1,$2::jsonb)
        ON CONFLICT(milling_type_id) DO UPDATE SET recipe=excluded.recipe,revision=cad_recipe_mappings.revision+1,updated_at=now()`, [millingTypeId, JSON.stringify(recipe)]);
      await this.event(db, user, key, 'cad.mapping.updated', null, String(millingTypeId), { before: old.rows[0]?.recipe, after: recipe });
      return { revision: revision + 1 };
    });
  }
  async tick() {
    if (!this.enabled || this.stopping) return;
    await this.database.withAdvisoryLock('cad-dispatcher-v1', async assertOwned => {
      const rows = await this.database.query<RunRow>(`SELECT * FROM cad_runs WHERE next_attempt_at<=now() AND
        (status IN ('queued','running') OR (package_requested AND package_id IS NULL)) ORDER BY updated_at LIMIT 1`);
      const run = rows.rows[0]; if (!run) return;
      try {
        await assertOwned();
        const remote = run.remote_job_id ? await this.client.job(run.remote_job_id, true) : await this.client.submit(run.payload, run.id);
        const pack = run.package_requested && !run.package_id && remote.status === 'succeeded' ? await this.client.package(remote.id) : null;
        await assertOwned();
        await this.database.transaction(async db => {
          await db.query(`UPDATE cad_runs SET remote_job_id=$2,status=$3,package_id=COALESCE($4,package_id),last_error=NULL,
            attempts=0,updated_at=now(),next_attempt_at=now()+interval '2 seconds' WHERE id=$1`, [run.id, remote.id, remote.status, pack?.id ?? null]);
          const revision = await db.query<{ data: CadVariant }>('SELECT data FROM cad_variant_revisions WHERE variant_id=$1 AND revision=$2', [run.variant_id, run.revision]);
          const variant = revision.rows[0].data;
          if (run.status !== remote.status && ['succeeded', 'partial', 'failed'].includes(remote.status)) {
            await this.event(db, run.actor, run.request_id, remote.status === 'succeeded' ? 'cad.render.completed' : 'cad.render.failed', variant, run.id, { status: remote.status }, run.id);
          }
          if (pack) await this.event(db, run.package_actor!, run.package_request_id!, 'cad.package.completed', variant, run.id, { artifactId: pack.id }, run.id);
        });
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'CAD_TRANSIENT_ERROR';
        await assertOwned();
        const terminal = run.attempts >= 4 || code === 'PRODUCTION_APPROVAL_REQUIRED' || code === 'PACKAGE_INCOMPLETE';
        await this.database.transaction(async db => {
          await db.query(`UPDATE cad_runs SET last_error=$2,attempts=attempts+1,updated_at=now(),
            next_attempt_at=now()+interval '15 seconds',package_requested=CASE WHEN $3 THEN false ELSE package_requested END,
            status=CASE WHEN $3 AND status IN ('queued','running') THEN 'failed' ELSE status END WHERE id=$1`, [run.id, code, terminal]);
          if (terminal) {
            const revision = await db.query<{ data: CadVariant }>('SELECT data FROM cad_variant_revisions WHERE variant_id=$1 AND revision=$2', [run.variant_id, run.revision]);
            const actor = run.package_requested ? run.package_actor! : run.actor;
            const requestId = run.package_requested ? run.package_request_id! : run.request_id;
            await this.event(db, actor, `${requestId}:attempt-${run.attempts + 1}`, run.package_requested ? 'cad.package.failed' : 'cad.render.failed', revision.rows[0].data, run.id, { code }, run.id);
          }
        });
      }
    });
  }
}
