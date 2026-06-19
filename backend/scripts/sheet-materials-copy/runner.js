const { buildSheetCopyPlan, compatible, materialToSpec } = require('./plan');
const { parseSheetDimensions } = require('./dimensions');

const PRODUCTION_MARKERS = /prod|production|live/i;
const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '::1'];

function requireValue(argv, i, flag) { const v = argv[i + 1]; if (v === undefined) throw new Error(`${flag} requires a value`); return v; }

function parseSheetCopyArgs(argv) {
  const parsed = { mode: 'dry-run', databaseUrl: null, targetEnv: null, materialTypeAllowlist: [1, 2],
    approveWrite: false, manifestOut: null, allowedDbHosts: [], runIdArg: null, expectedDbName: null, actor: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--mode': parsed.mode = requireValue(argv, i, arg); i += 1; break;
      case '--database-url': parsed.databaseUrl = requireValue(argv, i, arg); i += 1; break;
      case '--target-env': parsed.targetEnv = requireValue(argv, i, arg); i += 1; break;
      case '--material-types':
        parsed.materialTypeAllowlist = requireValue(argv, i, arg).split(',').map((s) => Number(s.trim())).filter(Number.isInteger);
        i += 1; break;
      case '--allowed-db-hosts':
        parsed.allowedDbHosts = requireValue(argv, i, arg).split(',').map((s) => s.trim()).filter(Boolean);
        i += 1; break;
      case '--approve-write': parsed.approveWrite = true; break;
      case '--manifest-out': parsed.manifestOut = requireValue(argv, i, arg); i += 1; break;
      case '--run-id': parsed.runIdArg = requireValue(argv, i, arg); i += 1; break;
      case '--expected-db-name': parsed.expectedDbName = requireValue(argv, i, arg); i += 1; break;
      case '--actor': parsed.actor = requireValue(argv, i, arg); i += 1; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['dry-run', 'write'].includes(parsed.mode)) throw new Error('--mode must be dry-run or write');
  return parsed;
}

function resolveSheetCopyConfig(parsed, env = process.env) {
  const targetEnv = parsed.targetEnv ?? env.SHEET_MATERIALS_COPY_TARGET_ENV ?? '';
  const envHosts = (env.SHEET_MATERIALS_COPY_ALLOWED_DB_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedDbHosts = Array.from(new Set([...DEFAULT_ALLOWED_HOSTS, ...parsed.allowedDbHosts, ...envHosts]));
  return {
    mode: parsed.mode,
    databaseUrl: parsed.databaseUrl ?? env.SHEET_MATERIALS_COPY_DATABASE_URL ?? '',
    targetEnv: typeof targetEnv === 'string' ? targetEnv.trim() : '',
    approveWrite: parsed.approveWrite || env.SHEET_MATERIALS_COPY_APPROVE_WRITE === 'true',
    materialTypeAllowlist: parsed.materialTypeAllowlist,
    allowedDbHosts, manifestOut: parsed.manifestOut, runIdArg: parsed.runIdArg,
    expectedDbName: parsed.expectedDbName ?? env.SHEET_MATERIALS_COPY_EXPECTED_DB_NAME ?? '',
    actor: parsed.actor ?? env.SHEET_MATERIALS_COPY_ACTOR ?? env.USER ?? 'unknown',
  };
}

function assertSheetCopyAllowed(config) {
  if (!['dry-run', 'write'].includes(config.mode)) throw new Error('--mode must be dry-run or write');
  if (!config.databaseUrl) throw new Error('--database-url or SHEET_MATERIALS_COPY_DATABASE_URL is required');
  if (config.targetEnv !== 'backend-test') throw new Error('--target-env backend-test (or SHEET_MATERIALS_COPY_TARGET_ENV=backend-test) is required');
  let host;
  try { host = new URL(config.databaseUrl).hostname.replace(/^\[(.*)\]$/, '$1'); }
  catch { throw new Error('--database-url is not a valid URL'); }
  if (PRODUCTION_MARKERS.test(host)) throw new Error('Refusing sheet-materials copy against a prod/production/live database host');
  if (!Array.isArray(config.allowedDbHosts) || !config.allowedDbHosts.includes(host)) {
    throw new Error(`Refusing sheet-materials copy: db host "${host}" is not in the allowed-db-hosts allowlist`);
  }
  if (!Array.isArray(config.materialTypeAllowlist) || config.materialTypeAllowlist.length === 0) throw new Error('--material-types must list at least one material_type_id');
  if (config.mode === 'write') {
    if (config.approveWrite !== true) throw new Error('write mode requires --approve-write or SHEET_MATERIALS_COPY_APPROVE_WRITE=true');
    if (!config.manifestOut) throw new Error('write mode requires --manifest-out <path> for the exported reversal manifest');
    if (!config.expectedDbName) throw new Error('write mode requires --expected-db-name (verified against current_database() before any write)');
  }
}

class SheetCopyConflictError extends Error {
  constructor(conflicts) {
    super(`Sheet-materials copy aborted: ${conflicts.length} name-collision conflict(s)`);
    this.name = 'SheetCopyConflictError';
    this.conflicts = conflicts;
  }
}

class SheetCopySourceDriftError extends Error {
  constructor(materialIds) {
    super(`Sheet-materials copy aborted: ${materialIds.length} source material(s) changed since planning (candidate drift)`);
    this.name = 'SheetCopySourceDriftError';
    this.materialIds = materialIds;
  }
}

const MATERIAL_COLS = `material_id AS "materialId", material_name AS "materialName",
  material_type_id AS "materialTypeId", unit_id AS "unitId",
  default_supplier_id AS "defaultSupplierId", vendor_id AS "vendorId",
  ref_key_1c::text AS "refKey1c", is_active AS "isActive", sheet_material_type_id AS "sheetMaterialTypeId"`;
const SELECT_MATERIALS = `SELECT ${MATERIAL_COLS} FROM materials ORDER BY material_id`;
  // Read UNLOCKED (Critic R10): locking all materials would block concurrent order saves via the
  // orders/order_details.material_id FK key-share path — that violates "no order impact". Only the
  // specific candidate rows are touched later (Critic R11), and orphan-safety comes from the link
  // UPDATE's identity guard + exactly-one-row assertion below.

// Verify the connected DB is actually the intended one (host allowlist alone can't prove
// which database on that host we reached — Critic R2 SECURITY). No-op when expectedDbName empty.
async function verifyDatabaseIdentity(client, expectedDbName) {
  if (!expectedDbName) return;
  const { rows } = await client.query('SELECT current_database() AS db');
  if (rows[0].db !== expectedDbName) {
    throw new Error(`Refusing: connected database "${rows[0].db}" != expected "${expectedDbName}"`);
  }
}

async function runSheetCopy(pool, config) {
  const allowlist = config.materialTypeAllowlist;
  const runId = config.runId ?? `sheet-copy-${Date.now()}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyDatabaseIdentity(client, config.expectedDbName);   // before any read/write
    const materials = (await client.query(SELECT_MATERIALS)).rows;
    const mapExistingRow = (r) => ({
      id: Number(r.id), materialTypeId: Number(r.materialTypeId), unitId: Number(r.unitId),
      supplierId: r.supplierId == null ? null : Number(r.supplierId),
      vendorId: r.vendorId == null ? null : Number(r.vendorId), refKey1c: r.refKey1c ?? null,
      isActive: r.isActive, thicknessMm: Number(r.thicknessMm), widthMm: Number(r.widthMm), heightMm: Number(r.heightMm),
      supplierArticle: r.supplierArticle ?? null, texture: r.texture ?? null, color: r.color ?? null });
    const EXISTING_COLS = `name, sheet_material_type_id AS id, material_type_id AS "materialTypeId", unit_id AS "unitId",
      supplier_id AS "supplierId", vendor_id AS "vendorId", ref_key_1c::text AS "refKey1c",
      is_active AS "isActive", thickness_mm AS "thicknessMm", width_mm AS "widthMm", height_mm AS "heightMm",
      supplier_article AS "supplierArticle", texture AS "texture", color AS "color"`;
    // Read UNLOCKED (Critic R10): locking the whole sheet_material_types table would block unrelated SP1
    // catalog edits. This snapshot only drives planning; correctness against concurrent edits comes from
    // narrow per-row locks taken at write time — the ON CONFLICT re-fetch FOR UPDATE for phantom inserts,
    // and the per-link re-fetch FOR UPDATE + re-validate for pre-existing link targets (below).
    const existingRows = (await client.query(`SELECT ${EXISTING_COLS} FROM sheet_material_types`)).rows;
    const existingByName = new Map(existingRows.map((r) => [r.name, mapExistingRow(r)]));

    const plan = buildSheetCopyPlan({ materials, existingSheetTypesByName: existingByName, materialTypeAllowlist: allowlist });

    // Fail-closed: never write when name-collision conflicts exist.
    if (plan.conflicts.length > 0) { await client.query('ROLLBACK'); throw new SheetCopyConflictError(plan.conflicts); }

    const placeholderDimensions = plan.inserts
      .filter((p) => !(p.dimsParsed.thickness && p.dimsParsed.width && p.dimsParsed.height))
      .map((p) => ({ name: p.name, dimsParsed: p.dimsParsed }));

    if (config.mode === 'dry-run') {
      await client.query('ROLLBACK');
      return { mode: 'dry-run', considered: materials.length, inserted: plan.inserts.length,
        linked: plan.links.length, skipped: plan.skipped.length, placeholderDimensions, reversalRecord: null };
    }

    // TRUE no-op rerun (Critic R6): nothing to insert AND nothing to link → make NO durable change.
    // Roll back, write NO ledger row, return reversalRecord: null so the CLI also skips the manifest export.
    // A second run is therefore a genuine no-op, per §12.
    if (plan.inserts.length === 0 && plan.links.length === 0) {
      await client.query('ROLLBACK');
      return { mode: 'write', considered: materials.length, inserted: 0, linked: 0,
        skipped: plan.skipped.length, placeholderDimensions, reversalRecord: null };
    }

    const nameToId = new Map(Array.from(existingByName, ([n, v]) => [n, v.id]));
    const createdSheetMaterialTypeIds = [];
    for (const ins of plan.inserts) {
      const res = await client.query(
        `INSERT INTO sheet_material_types (name, material_type_id, unit_id, thickness_mm, width_mm, height_mm, supplier_id, vendor_id, ref_key_1c, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,true)
         ON CONFLICT (name) DO NOTHING RETURNING sheet_material_type_id AS id`,
        [ins.name, ins.materialTypeId, ins.unitId, ins.thicknessMm, ins.widthMm, ins.heightMm, ins.supplierId, ins.vendorId, ins.refKey1c]);
      if (res.rows.length > 0) { const id = Number(res.rows[0].id); nameToId.set(ins.name, id); createdSheetMaterialTypeIds.push(id); }
      else {
        // ON CONFLICT: a same-name row already exists (TOCTOU vs the planning snapshot — Critic R3).
        // Re-fetch the FULL row and RE-VALIDATE compatibility inside the tx before linking.
        const found = (await client.query(`SELECT ${EXISTING_COLS} FROM sheet_material_types WHERE name = $1 FOR UPDATE`, [ins.name])).rows[0];
        // The conflicting row could be deleted between the ON CONFLICT and this re-fetch → controlled error, not a TypeError (tier2).
        if (!found) { await client.query('ROLLBACK'); throw new SheetCopyConflictError([{ materialId: ins.materialId, name: ins.name, reason: 'existing-row-mismatch', detail: 'race: conflicting row disappeared before re-fetch' }]); }
        const row = mapExistingRow(found);   // FOR UPDATE locks this phantom row before we link to it (Critic R5)
        if (!compatible(row, ins)) { await client.query('ROLLBACK'); throw new SheetCopyConflictError([{ materialId: ins.materialId, name: ins.name, reason: 'existing-row-mismatch', detail: 'race: incompatible row appeared before insert' }]); }
        nameToId.set(ins.name, row.id);
      }
    }

    const createdIdSet = new Set(createdSheetMaterialTypeIds);
    const materialById = new Map(materials.map((m) => [m.materialId, m]));
    const links = [];
    for (const link of plan.links) {
      let sheetId = nameToId.get(link.name);
      const snap = materialById.get(link.materialId);   // planning-snapshot row for this material
      // PRE-EXISTING link target (not created by this run): the planning snapshot was read unlocked, so
      // lock THIS ONE row FOR UPDATE and re-validate it now before linking (narrow lock — does not block
      // unrelated SP1 edits; Critic R4/R10). Rows created this run are already held by our own INSERT.
      if (!createdIdSet.has(sheetId)) {
        const cur = (await client.query(`SELECT ${EXISTING_COLS} FROM sheet_material_types WHERE sheet_material_type_id = $1 FOR UPDATE`, [sheetId])).rows;
        if (cur.length === 0) { await client.query('ROLLBACK'); throw new SheetCopyConflictError([{ materialId: link.materialId, name: link.name, reason: 'existing-row-mismatch', detail: 'race: link target row disappeared' }]); }
        const row = mapExistingRow(cur[0]);
        if (!compatible(row, materialToSpec(snap))) {
          await client.query('ROLLBACK'); throw new SheetCopyConflictError([{ materialId: link.materialId, name: link.name, reason: 'existing-row-mismatch', detail: 'race: link target became incompatible before link' }]);
        }
        sheetId = row.id;
      }
      // OPTIMISTIC, identity-guarded link (Critic R12): NO held FOR UPDATE on the source material (which would
      // block order saves on it for the whole run). Instead the UPDATE's WHERE embeds the planning-snapshot
      // identity — if the material was renamed/retyped/re-unit'd, had supplier/vendor/1C changed, was
      // deactivated, OR was concurrently linked, it matches 0 rows → fail closed, roll back the WHOLE run.
      const upd = await client.query(
        `UPDATE materials SET sheet_material_type_id = $2, updated_at = now()
         WHERE material_id = $1 AND sheet_material_type_id IS NULL AND is_active = true
           AND material_name = $3 AND material_type_id = $4 AND unit_id = $5
           AND default_supplier_id IS NOT DISTINCT FROM $6
           AND vendor_id IS NOT DISTINCT FROM $7
           AND ref_key_1c IS NOT DISTINCT FROM $8::uuid`,
        [link.materialId, sheetId, snap.materialName, snap.materialTypeId, snap.unitId, snap.defaultSupplierId, snap.vendorId, snap.refKey1c]);
      if (upd.rowCount !== 1) { await client.query('ROLLBACK'); throw new SheetCopySourceDriftError([link.materialId]); }
      links.push({ materialId: link.materialId, previousSheetMaterialTypeId: null, sheetMaterialTypeId: sheetId });
    }

    // Durable reversal + provenance record — same transaction as the writes above.
    // db_user/database_name read from the live session so the ledger reflects reality, not args.
    const idRow = (await client.query('SELECT current_user AS u, current_database() AS d')).rows[0];
    await client.query(
      `INSERT INTO sheet_material_copy_runs
         (run_id, actor, source, target_env, db_user, database_name, material_type_allowlist, created_sheet_material_type_ids, links)
       VALUES ($1, $2, 'sheet-materials-copy-runner', $3, $4, $5, $6::smallint[], $7::bigint[], $8::jsonb)`,
      [runId, config.actor ?? 'unknown', config.targetEnv ?? 'unknown', idRow.u, idRow.d,
       allowlist, createdSheetMaterialTypeIds, JSON.stringify(links)]);

    await client.query('COMMIT');
    return { mode: 'write', considered: materials.length, inserted: createdSheetMaterialTypeIds.length,
      linked: links.length, skipped: plan.skipped.length, placeholderDimensions,
      reversalRecord: { runId, createdSheetMaterialTypeIds, links } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

// Schema-aware: every FK column that references sheet_material_types in the current schema.
async function findSheetMaterialReferrers(client) {
  const res = await client.query(`
    SELECT c.conrelid::regclass::text AS ref, a.attname AS col
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'sheet_material_types'::regclass`);
  return res.rows.map((r) => ({ ref: r.ref, col: r.col }));
}

class SheetReverseBlockedError extends Error {
  constructor(referencedIds) {
    super(`Sheet-materials reverse aborted: ${referencedIds.length} created row(s) still referenced by a foreign key`);
    this.name = 'SheetReverseBlockedError';
    this.referencedIds = referencedIds;
  }
}

class SheetReverseDriftError extends Error {
  constructor(materialId, expectedSheetMaterialTypeId) {
    super(`Sheet-materials reverse aborted: material_id=${materialId} no longer links to the run-created sheet_material_type_id=${expectedSheetMaterialTypeId} (manual drift)`);
    this.name = 'SheetReverseDriftError';
    this.materialId = materialId;
    this.expectedSheetMaterialTypeId = expectedSheetMaterialTypeId;
  }
}

async function reverseSheetCopy(pool, runId, options = {}) {
  const { actor = 'unknown', expectedDbName = '' } = options;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyDatabaseIdentity(client, expectedDbName);
    const runRes = await client.query('SELECT created_sheet_material_type_ids AS ids, links FROM sheet_material_copy_runs WHERE run_id = $1 AND reversed_at IS NULL FOR UPDATE', [runId]);
    if (runRes.rows.length === 0) throw new Error(`No un-reversed sheet-materials copy run with run_id=${runId}`);
    const ids = runRes.rows[0].ids.map(Number);
    const links = runRes.rows[0].links;   // JSONB → array

    // Step 0 — LOCK the created sheet rows FOR UPDATE for the whole reverse tx (Critic R12 TOCTOU): the FK
    // `materials.sheet_material_type_id -> sheet_material_types` is ON DELETE SET NULL, so without this lock a
    // concurrent session could add a NEW link to a created id AFTER the referrer preflight and BEFORE delete,
    // and the delete would silently NULL it instead of blocking. Locking the targets makes any concurrent
    // linker block until reverse ends, so the preflight result cannot change before the delete.
    if (ids.length > 0) {
      await client.query('SELECT 1 FROM sheet_material_types WHERE sheet_material_type_id = ANY($1::bigint[]) ORDER BY sheet_material_type_id FOR UPDATE', [ids]);
    }

    // Step 1 — restore THIS run's recorded materials links first. After this, the created rows are
    // no longer referenced by the links this run wrote (Critic R3 BLOCKER: `materials.sheet_material_type_id`
    // is itself an FK to sheet_material_types, so preflighting ALL FKs before unlinking would always
    // self-block). Everything is in ONE transaction, so a later abort still rolls this back — atomic.
    let unlinked = 0;
    for (const link of links) {
      const res = await client.query(
        'UPDATE materials SET sheet_material_type_id = $2, updated_at = now() WHERE material_id = $1 AND sheet_material_type_id = $3',
        [link.materialId, link.previousSheetMaterialTypeId, link.sheetMaterialTypeId]);
      // Fail closed on link DRIFT (Critic R7): if a copied material was manually repointed after the copy,
      // this restore matches 0 rows. Refuse to "reverse" a run we cannot truly restore — rollback (atomic,
      // reverts any earlier restores) and throw, leaving the run un-reversed for an operator to resolve.
      if (res.rowCount !== 1) { await client.query('ROLLBACK'); throw new SheetReverseDriftError(link.materialId, link.sheetMaterialTypeId); }
      unlinked += 1;
    }

    // Step 2 — any REMAINING reference to a created id is EXTERNAL (a row this run did not link:
    // a manual materials link, or order_details/orders after SP3). Schema-aware via pg_constraint.
    const referrers = await findSheetMaterialReferrers(client);
    const blocked = [];
    for (const id of ids) {
      for (const r of referrers) {
        const hit = await client.query(`SELECT 1 FROM ${r.ref} WHERE ${r.col} = $1 LIMIT 1`, [id]); // ref/col from pg_constraint, never user input
        if (hit.rowCount > 0) { blocked.push(id); break; }
      }
    }
    // ATOMIC abort: rollback undoes Step 1's unlinks too, leaving the run fully un-reversed.
    if (blocked.length > 0) { await client.query('ROLLBACK'); throw new SheetReverseBlockedError(blocked); }

    // Step 3 — delete only the rows this run created.
    let deleted = 0;
    for (const id of ids) {
      const del = await client.query('DELETE FROM sheet_material_types WHERE sheet_material_type_id = $1', [id]);
      deleted += del.rowCount;
    }
    await client.query('UPDATE sheet_material_copy_runs SET reversed_at = now(), reversed_by = $2 WHERE run_id = $1', [runId, actor]);
    await client.query('COMMIT');
    return { runId, unlinked, deleted, refusedDeletes: [] };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
}

module.exports = { parseSheetCopyArgs, resolveSheetCopyConfig, assertSheetCopyAllowed,
  runSheetCopy, reverseSheetCopy, SheetCopyConflictError, SheetCopySourceDriftError,
  SheetReverseBlockedError, SheetReverseDriftError, buildSheetCopyPlan, parseSheetDimensions };
