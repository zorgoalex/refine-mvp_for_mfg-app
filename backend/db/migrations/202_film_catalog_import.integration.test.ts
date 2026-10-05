import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;
const prefix = 'E2E-Тест';

describe.skipIf(!url)('202 film catalog import PostgreSQL integration', () => {
  let pool: Pool;
  let client: PoolClient;
  let actorId: string;
  let otherActorId: string;
  let vendorId: number;
  let filmTypeId: number;
  let batchId: string;
  let savepointNumber = 0;

  async function inSavepoint(run: () => Promise<void>): Promise<void> {
    const savepoint = `film_catalog_case_${++savepointNumber}`;
    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await run();
    } finally {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
  }

  async function createFilm(label: string, extra: {
    isActive?: boolean;
    canonicalFilmId?: string | null;
    catalogKey?: string | null;
    refKey?: string | null;
    editedBy?: string;
  } = {}): Promise<string> {
    const name = `${prefix}-${label}-${randomUUID()}`;
    const result = await client.query<{ film_id: string }>(
      `INSERT INTO public.films
         (film_name, vendor_id, film_type_id, film_texture, is_active, created_by, edited_by,
          canonical_film_id, catalog_key, ref_key_1c)
       VALUES ($1, $2, $3, false, $4, $5, $6, $7, $8, $9)
       RETURNING film_id`,
      [name, vendorId, filmTypeId, extra.isActive ?? true, actorId, extra.editedBy ?? actorId,
        extra.canonicalFilmId ?? null, extra.catalogKey ?? null, extra.refKey ?? null],
    );
    return result.rows[0].film_id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    const present = await client.query<{ present: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='films' AND column_name='canonical_film_id') AS present`,
    );
    if (!present.rows[0].present) {
      const migration = await readFile(new URL('./202_film_catalog_import.sql', import.meta.url), 'utf8');
      await client.query(migration);
    }

    const base = await client.query<{ user_id: string; role_id: number; material_type_id: number }>(
      `SELECT (SELECT min(user_id) FROM public.users)::text AS user_id,
              (SELECT min(role_id) FROM public.roles) AS role_id,
              (SELECT min(material_type_id) FROM public.material_types) AS material_type_id`,
    );
    const ownerId = base.rows[0].user_id;
    await client.query("SELECT set_config('app.user_id', $1, true)", [ownerId]);
    const firstUser = await client.query<{ user_id: string }>(
      `INSERT INTO public.users (username, email, password_hash, role_id, full_name, created_by)
       VALUES ($1, $2, 'test-hash', $3, $4, $5) RETURNING user_id`,
      [`${prefix}-actor-${randomUUID()}`, `${randomUUID()}@example.invalid`, base.rows[0].role_id, `${prefix} actor`, ownerId],
    );
    actorId = firstUser.rows[0].user_id;
    const secondUser = await client.query<{ user_id: string }>(
      `INSERT INTO public.users (username, email, password_hash, role_id, full_name, created_by)
       VALUES ($1, $2, 'test-hash', $3, $4, $5) RETURNING user_id`,
      [`${prefix}-actor-${randomUUID()}`, `${randomUUID()}@example.invalid`, base.rows[0].role_id, `${prefix} actor two`, ownerId],
    );
    otherActorId = secondUser.rows[0].user_id;
    await client.query("SELECT set_config('app.user_id', $1, true)", [actorId]);

    const vendor = await client.query<{ vendor_id: number }>(
      `INSERT INTO public.vendors (vendor_name, material_type_id, created_by)
       VALUES ($1, $2, $3) RETURNING vendor_id`,
      [`${prefix} vendor ${randomUUID()}`, base.rows[0].material_type_id, actorId],
    );
    vendorId = vendor.rows[0].vendor_id;
    const filmType = await client.query<{ film_type_id: number }>(
      `INSERT INTO public.film_types (film_type_name, created_by)
       VALUES ($1, $2) RETURNING film_type_id`,
      [`${prefix} type ${randomUUID()}`, actorId],
    );
    filmTypeId = filmType.rows[0].film_type_id;
    const batch = await client.query<{ batch_id: string }>(
      `INSERT INTO public.catalog_import_batches
         (source_kind, file_name, file_sha256, sheet_name, status, created_by, request_id)
       VALUES ('file', 'fixture.xlsx', $1, 'Пленки', 'draft', $2, $3)
       RETURNING batch_id`,
      ['a'.repeat(64), actorId, randomUUID()],
    );
    batchId = batch.rows[0].batch_id;
  }, 30_000);

  afterAll(async () => {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }
    await pool?.end();
  });

  it('guards backend-owned catalog fields and permits backend-local updates', async () => {
    await inSavepoint(async () => {
      const canonical = await createFilm('guard-target');
      const duplicate = await createFilm('guard-duplicate', { isActive: false });
      await client.query('SAVEPOINT denied_backend_update');
      await expect(client.query('UPDATE public.films SET canonical_film_id=$1 WHERE film_id=$2', [canonical, duplicate]))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT denied_backend_update');
      await client.query('RELEASE SAVEPOINT denied_backend_update');
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      await client.query('UPDATE public.films SET canonical_film_id=$1 WHERE film_id=$2', [canonical, duplicate]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      // Вне транзакции импорта (настройка снята) вставка с catalog_key запрещена.
      await client.query("SELECT set_config('erp.film_catalog', '', true)");
      await expect(client.query(
        `INSERT INTO public.films (film_name,vendor_id,film_type_id,created_by,edited_by,catalog_key)
         VALUES ($1,$2,$3,$4,$4,'blocked-key')`,
        [`${prefix}-blocked-${randomUUID()}`, vendorId, filmTypeId, actorId],
      )).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('rejects merge chains and merging a film that already has duplicates', async () => {
    await inSavepoint(async () => {
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      const a = await createFilm('chain-a', { isActive: false });
      const b = await createFilm('chain-b', { isActive: false });
      const c = await createFilm('chain-c');
      await client.query('UPDATE public.films SET canonical_film_id=$1 WHERE film_id=$2', [b, a]);
      await client.query('UPDATE public.films SET canonical_film_id=$1 WHERE film_id=$2', [c, b]);
      await expect(client.query('SET CONSTRAINTS ALL IMMEDIATE')).rejects.toMatchObject({ code: '23514' });
    });
    await inSavepoint(async () => {
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      const canonical = await createFilm('already-referenced');
      const duplicate = await createFilm('already-duplicate', { isActive: false, canonicalFilmId: canonical });
      const third = await createFilm('would-be-duplicate', { isActive: false });
      await client.query('UPDATE public.films SET canonical_film_id=$1 WHERE film_id=$2', [canonical, third]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await expect(client.query('UPDATE public.films SET canonical_film_id=$1 WHERE film_id=$2', [duplicate, third]))
        .rejects.toMatchObject({ code: '23514' });
    });
  });

  it('enforces inactive, no-key, and canonical-only name uniqueness checks', async () => {
    await inSavepoint(async () => {
      const canonical = await createFilm('check-canonical');
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      await expect(createFilm('active-duplicate', { canonicalFilmId: canonical }))
        .rejects.toMatchObject({ code: '23514' });
    });
    await inSavepoint(async () => {
      const canonical = await createFilm('key-canonical');
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      await expect(createFilm('keyed-duplicate', {
        isActive: false, canonicalFilmId: canonical, catalogKey: 'catalog-key',
      })).rejects.toMatchObject({ code: '23514' });
    });
    await inSavepoint(async () => {
      const canonical = await createFilm('ref-canonical');
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      await expect(createFilm('refkey-duplicate', {
        isActive: false, canonicalFilmId: canonical, refKey: randomUUID(),
      })).rejects.toMatchObject({ code: '23514' });
    });
    await inSavepoint(async () => {
      const name = `${prefix}-same-duplicate-${randomUUID()}`;
      const canonical = await createFilm('same-name-seed');
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [name, canonical]);
      await client.query("SELECT set_config('erp.film_catalog', 'on', true)");
      const duplicateOne = await createFilm('same-name-dup-1', { isActive: false, canonicalFilmId: canonical });
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [name, duplicateOne]);
      const duplicateTwo = await createFilm('same-name-dup-2', { isActive: false, canonicalFilmId: canonical });
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [name, duplicateTwo]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect(duplicateTwo).not.toBe(duplicateOne);
      const anotherCanonical = await createFilm('same-name-canonical');
      await expect(client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [name, anotherCanonical]))
        .rejects.toMatchObject({ code: '23505', constraint: 'uq_films_name_vendor_canonical' });
    });
  });

  it('records name history actor and source safely, excluding edited_by', async () => {
    await inSavepoint(async () => {
      const filmId = await createFilm('history');
      await client.query("SELECT set_config('erp.film_change_actor', $1, true)", [actorId]);
      await client.query("SELECT set_config('erp.film_change_source', 'catalog_import', true)");
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-import`, filmId]);

      await client.query("SELECT set_config('erp.film_change_actor', '', true)");
      await client.query("SELECT set_config('hasura.user', $1, true)", [JSON.stringify({ 'x-hasura-user-id': otherActorId })]);
      await client.query("SELECT set_config('erp.film_change_source', 'manual', true)");
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-hasura`, filmId]);

      await client.query("SELECT set_config('hasura.user', '', true)");
      await client.query("SELECT set_config('app.user_id', $1, true)", [otherActorId]);
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-app-user`, filmId]);

      await client.query("SELECT set_config('app.user_id', '', true)");
      await client.query("SELECT set_config('hasura.user', 'not-json', true)");
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-bad-json`, filmId]);
      await client.query("SELECT set_config('hasura.user', '', true)");
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-unknown`, filmId]);

      await client.query('UPDATE public.films SET edited_by=$1 WHERE film_id=$2', [otherActorId, filmId]);
      await client.query("SELECT set_config('erp.film_change_actor', $1, true)", [actorId]);
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-stale-editor`, filmId]);
      await client.query('UPDATE public.films SET film_name=film_name WHERE film_id=$1', [filmId]);

      await client.query("SELECT set_config('erp.film_change_actor', 'abc', true)");
      await client.query('UPDATE public.films SET film_name=$1 WHERE film_id=$2', [`${prefix}-renamed-garbage`, filmId]);

      const history = await client.query<{ changed_by: string | null; source: string }>(
        `SELECT changed_by::text, source FROM public.film_name_history WHERE film_id=$1 ORDER BY history_id`, [filmId],
      );
      expect(history.rows).toEqual([
        { changed_by: actorId, source: 'catalog_import' },
        { changed_by: otherActorId, source: 'manual' },
        { changed_by: otherActorId, source: 'manual' },
        { changed_by: null, source: 'manual_unknown_actor' },
        { changed_by: null, source: 'manual_unknown_actor' },
        { changed_by: actorId, source: 'manual' },
        { changed_by: null, source: 'manual_unknown_actor' },
      ]);
    });
  });

  it('only reserves catalog keys for valid rows and validates batch source_kind', async () => {
    await inSavepoint(async () => {
      const key = `${prefix}-key-${randomUUID()}`;
      const insertRow = (status: 'invalid' | 'ok', rowNo: number) => client.query(
        `INSERT INTO public.catalog_import_rows
          (batch_id,row_no,name_original,name_full,supplier,target_name,catalog_key,row_status)
         VALUES ($1,$2,'original','full','supplier','target',$3,$4)`, [batchId, rowNo, key, status],
      );
      await insertRow('invalid', 1);
      await insertRow('invalid', 2);
      await insertRow('ok', 3);
      await expect(insertRow('ok', 4)).rejects.toMatchObject({ code: '23505', constraint: 'uq_catalog_import_rows_key' });
    });
    await inSavepoint(async () => {
      await expect(client.query(
        `INSERT INTO public.catalog_import_batches (source_kind,file_name,file_sha256,sheet_name,status,created_by,request_id)
         VALUES ('unsupported','file.xlsx',$1,'Sheet1','draft',$2,$3)`,
        ['b'.repeat(64), actorId, randomUUID()],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });
});
