import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import * as XLSX from 'xlsx';
import { DatabaseService } from '../../../database/database.service';
import type {
  DatabaseClient,
  TransactionClient,
} from '../../../database/database.types';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import {
  normalizeUnit,
  catalogKeyOf,
  parseCatalogDescription,
  validateCatalogRows,
  type CatalogRowInput,
} from '../../../shared/film-catalog';
import {
  analyzeFilmName,
  scoreCandidate,
} from '../../films/domain/film-name-normalizer';
import { OnecCatalogReader } from '../../onec-agent/onec-catalog-reader';
import {
  applyPatchActions,
  assignCanonicals,
  buildMatches,
  canAccessSourceKind,
  filmFingerprint,
  normalizeFilmBusinessFields,
  noteWithPreviousName,
  refreshMatches,
  supplierNorm,
  vendorMatchMap,
  type CatalogAction,
  type FilmCandidate,
  type ImportRow,
  type MatchResult,
} from '../domain/catalog-import';
import {
  DECISIONS_FORMAT,
  DECISIONS_MAX_ROWS,
  DECISIONS_VERSION,
  FINGERPRINT_VERSION,
  planReplay,
  verifyDecisionsFile,
  withSha,
  type DecisionRow,
  type DecisionVendor,
  type DecisionsFile,
  type ReplayPlan,
} from '../domain/catalog-decisions';

const VENDOR_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ['алимжан aif', 'Аиф'],
  ['kira', 'Kira'],
  ['decor +', 'Decor+'],
  ['decor 777', 'Decor777'],
  ['евразия декор', 'Евразия Декор'],
  ['алер', 'Алер'],
  ['adilet', 'ADILET'],
  ['safa', 'SAFA'],
  ['focusprime', 'Focus Prime'],
  ['мс-груп', 'МС груп'],
];
const json = (value: unknown) => JSON.stringify(value);
interface CreateInput {
  kind: 'films';
  source: 'file' | 'onec_mirror' | 'decisions';
  decisions?: DecisionsFile;
  fileName?: string;
  fileSha256?: string;
  sheetName?: string;
  rows?: CatalogRowInput[];
  onecSourceId?: number;
  categoryKey?: string;
  prepareRows?: () => Promise<Array<ReturnType<typeof validateCatalogRows>[number] & {
    onecSourceKey?: string;
    onecRowHash?: string;
    refKey1c?: string;
  }>>;
}

@Injectable()
export class CatalogImportService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OnecCatalogReader) private readonly onec: OnecCatalogReader
  ) {}

  async create(
    body: CreateInput,
    userId: number,
    requestId: string,
    key: string
  ) {
    if (body.kind !== 'films') throw validation('kind must be films');
    const source = body.source;
    if (source === 'file') {
      if (
        typeof body.fileName !== 'string' ||
        !body.fileName.trim() ||
        typeof body.sheetName !== 'string' ||
        !body.sheetName.trim() ||
        typeof body.fileSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(body.fileSha256) ||
        !Array.isArray(body.rows) ||
        body.rows.length < 1 ||
        body.rows.length > 5000
      )
        throw validation('Invalid file import body');
      const rows = body.rows;
      if (
        rows.some(
          (row) =>
            !row ||
            typeof row !== 'object' ||
            [
              row.nameOriginal,
              row.nameFull,
              row.supplier,
              row.nomenclatureType ?? '',
              row.unit ?? '',
              row.nomenclatureCategory ?? '',
            ].some((v) => typeof v !== 'string' || v.length > 500)
        )
      )
        throw validation('Catalog fields must be strings up to 500 characters');
      return this.createSnapshot({
        sourceKind: 'file',
        rows: validateCatalogRows(rows),
        fileName: body.fileName.trim(),
        fileSha256: body.fileSha256,
        sheetName: body.sheetName.trim(),
        userId,
        requestId,
        key,
        requestShape: {
          kind: 'films', source: 'file', fileName: body.fileName.trim(),
          fileSha256: body.fileSha256, sheetName: body.sheetName.trim(), rows,
        },
      });
    }
    if (source === 'onec_mirror') {
      const sourceId = Number(body.onecSourceId);
      const categoryKey = String(body.categoryKey ?? '');
      if (!Number.isSafeInteger(sourceId) || sourceId < 1 || !categoryKey)
        throw validation('Invalid mirror source/category');
      return this.createSnapshot({
        sourceKind: 'onec_mirror',
        sourceId,
        categoryKey,
        userId,
        requestId,
        key,
        requestShape: { kind: 'films', source: 'onec_mirror', onecSourceId: sourceId, categoryKey },
        prepareRows: async () => {
          const items = (await this.onec.listCatalogItems(sourceId, categoryKey))
            .filter((item) => !item.deletionMark && !item.isFolder);
          if (!items.length)
            throw new ApiError(409, 'ONEC_MIRROR_UNAVAILABLE', 'Источник или категория зеркала недоступны');
          const inputs: CatalogRowInput[] = items.map((item, index) => {
            const parsed = parseCatalogDescription(item.description);
            return {
              rowNo: index + 1,
              nameOriginal: parsed?.nameOriginal ?? item.description,
              supplier: parsed?.supplier ?? '',
              nameFull: item.description,
              nomenclatureType: item.nomenclatureType,
              unit: item.unitName,
              nomenclatureCategory: item.categoryName,
            };
          });
          return validateCatalogRows(inputs).map((row, index) => ({
            ...row,
            onecSourceKey: items[index]?.sourceKey,
            onecRowHash: items[index]?.rowHash,
            refKey1c: items[index]?.sourceKey,
          }));
        },
      });
    }
    if (source === 'decisions') {
      if (!body.decisions) throw validation('decisions file is required');
      return this.createFromDecisions(body.decisions, userId, requestId, key);
    }
    throw validation('source must be file, onec_mirror or decisions');
  }

  /**
   * Файл решений применённого пакета (план §C): строки каталога с исходом `existing`
   * (плёнки + сохранённые отпечатки черновика + роли) или `create` (без stage-ID) и
   * поставщики с названием/типом материала. Только для пакета `applied`.
   */
  async exportDecisions(id: number, permissions: readonly string[]): Promise<DecisionsFile> {
    const batch = await this.getBatch(id, permissions);
    if (batch.status !== 'applied')
      throw new ApiError(409, 'CATALOG_IMPORT_NOT_APPLIED', 'Файл решений выгружается только из применённого пакета');
    const rows = await this.db.query(
      `SELECT * FROM catalog_import_rows WHERE batch_id=$1 AND row_status='ok' ORDER BY row_no,row_id`,
      [id]
    );
    const matches = await this.db.query<{ film_id: string; row_id: string; fingerprint: string; after: Record<string, unknown> }>(
      `SELECT film_id,row_id,fingerprint,after FROM catalog_import_matches WHERE batch_id=$1 AND row_id IS NOT NULL AND after IS NOT NULL ORDER BY film_id`,
      [id]
    );
    const byRow = new Map<number, typeof matches.rows>();
    for (const m of matches.rows) {
      const list = byRow.get(Number(m.row_id)) ?? [];
      list.push(m);
      byRow.set(Number(m.row_id), list);
    }
    const vendorByNorm = new Map<string, number>();
    const decisionRows: DecisionRow[] = [];
    for (const row of rows.rows) {
      const group = byRow.get(Number(row.row_id)) ?? [];
      if (!group.length) continue;
      const created = group.some((m) => m.after?.created === true);
      const lead = group.find((m) => m.after?.created === true || m.after?.canonical_film_id === null) ?? group[0];
      const norm = supplierNorm(String(row.supplier));
      if (lead.after?.vendor_id !== null && lead.after?.vendor_id !== undefined) vendorByNorm.set(norm, Number(lead.after.vendor_id));
      decisionRows.push({
        catalogKey: String(row.catalog_key),
        onecRefKey: row.ref_key_1c ? String(row.ref_key_1c).toLowerCase() : null,
        rowNo: Number(row.row_no),
        nameOriginal: String(row.name_original),
        nameFull: String(row.name_full),
        supplier: String(row.supplier),
        nomenclatureType: row.nomenclature_type ?? null,
        unit: row.unit ?? null,
        nomenclatureCategory: row.nomenclature_category ?? null,
        targetName: String(row.target_name),
        supplierNorm: norm,
        canonicalFilmTexture: row.canonical_film_texture === null ? null : Boolean(row.canonical_film_texture),
        canonicalFilmTypeId: row.canonical_film_type_id === null ? null : Number(row.canonical_film_type_id),
        outcome: created ? 'create' : 'existing',
        films: created ? [] : group.map((m) => ({
          filmId: Number(m.film_id),
          fingerprint: m.fingerprint,
          role: m.after?.canonical_film_id === null || m.after?.canonical_film_id === undefined ? 'canonical' as const : 'duplicate' as const,
        })),
      });
    }
    // Поставщики — только из снимка на момент применения (текущий справочник мог измениться).
    const snapshot = (batch.options as { appliedVendors?: DecisionVendor[] } | null)?.appliedVendors;
    if (!snapshot)
      throw new ApiError(409, 'CATALOG_DECISIONS_NO_SNAPSHOT', 'Пакет применён до поддержки файла решений — выгрузка невозможна; примените пакет заново');
    const snapshotByNorm = new Map(snapshot.map((v) => [v.supplierNorm, v]));
    const vendors: DecisionVendor[] = [...vendorByNorm.keys()].map((norm) => {
      const v = snapshotByNorm.get(norm);
      if (!v) throw new ApiError(409, 'CATALOG_DECISIONS_NO_SNAPSHOT', `Нет снимка поставщика «${norm}» в пакете`);
      return v;
    }).sort((x, y) => x.supplierNorm.localeCompare(y.supplierNorm));
    return withSha({
      format: DECISIONS_FORMAT,
      version: DECISIONS_VERSION,
      fingerprintVersion: FINGERPRINT_VERSION,
      sourceBatchId: id,
      exportedAt: new Date().toISOString(),
      rows: decisionRows,
      vendors,
    });
  }

  /**
   * Поставщики файла решений: тот же id с тем же названием и типом материала → название +
   * тип материала → (created) создать с экспортированными названием и типом. Название
   * сравнивается ТОЧНО — как UNIQUE (vendor_name, material_type_id) в БД: вставка
   * `ON CONFLICT … DO NOTHING` + повторный SELECT атомарны относительно любых writers (в т.ч.
   * Hasura). `create=false` — только проверка для сводки черновика; `create=true` — окончательно
   * в транзакции apply: найденные строки берутся FOR SHARE (не меняются и не удаляются до commit;
   * изменённая до блокировки строка перепроверяется по условию и не находится), снимок
   * `appliedVendors` читается из тех же заблокированных строк.
   */
  private async resolveDecisionVendors(tx: TransactionClient, vendors: DecisionVendor[], create: boolean, userId: number) {
    // inserted — поставщика вставила ЭТА транзакция (INSERT … RETURNING вернул строку); найденный
    // чужой (в т.ч. вставленный параллельно) не считается созданным пакетом.
    const resolved = new Map<string, { vendorId: number | null; create: boolean; inserted: boolean }>();
    const unresolved: DecisionVendor[] = [];
    for (const vendor of vendors) {
      const byId = await tx.query<{ vendor_id: string }>(
        `SELECT vendor_id FROM vendors WHERE vendor_id=$1 AND vendor_name=$2 AND material_type_id IS NOT DISTINCT FROM $3${create ? ' FOR SHARE' : ''}`,
        [vendor.vendorId, vendor.vendorName, vendor.materialTypeId]
      );
      let vendorId = byId.rows[0] ? Number(byId.rows[0].vendor_id) : null;
      if (vendorId === null) {
        const byName = await tx.query<{ vendor_id: string }>(
          `SELECT vendor_id FROM vendors WHERE vendor_name=$1 AND material_type_id IS NOT DISTINCT FROM $2${create ? ' FOR SHARE' : ''}`,
          [vendor.vendorName, vendor.materialTypeId]
        );
        vendorId = byName.rows[0] ? Number(byName.rows[0].vendor_id) : null;
      }
      if (vendorId === null && vendor.created) {
        if (!create) {
          resolved.set(vendor.supplierNorm, { vendorId: null, create: true, inserted: false });
          continue;
        }
        const inserted = await tx.query<{ vendor_id: string }>(
          `INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3) ON CONFLICT ON CONSTRAINT uq_vendors_name_material_type DO NOTHING RETURNING vendor_id`,
          [vendor.vendorName, vendor.materialTypeId, userId]
        );
        if (inserted.rows[0]) {
          resolved.set(vendor.supplierNorm, { vendorId: Number(inserted.rows[0].vendor_id), create: false, inserted: true });
          continue;
        }
        // Конфликт: строку вставила другая транзакция — используем её (FOR SHARE), но не как созданную пакетом.
        const concurrent = await tx.query<{ vendor_id: string }>(
          `SELECT vendor_id FROM vendors WHERE vendor_name=$1 AND material_type_id IS NOT DISTINCT FROM $2 FOR SHARE`,
          [vendor.vendorName, vendor.materialTypeId]
        );
        vendorId = concurrent.rows[0] ? Number(concurrent.rows[0].vendor_id) : null;
      }
      if (vendorId === null) unresolved.push(vendor);
      else resolved.set(vendor.supplierNorm, { vendorId, create: false, inserted: false });
    }
    return { resolved, unresolved };
  }

  /** Черновик строгого повтора из файла решений (только для чтения, план §C). */
  private async createFromDecisions(file: DecisionsFile, userId: number, requestId: string, key: string) {
    try {
      verifyDecisionsFile(file);
    } catch (error) {
      throw new ApiError(422, 'CATALOG_DECISIONS_INVALID', error instanceof Error ? error.message : String(error));
    }
    if (file.rows.length > DECISIONS_MAX_ROWS) throw validation(`Не больше ${DECISIONS_MAX_ROWS} строк`);
    return this.db.transaction(async (tx) => {
      const replay = await this.claim(tx, key, 'catalog_import.create', userId, { kind: 'films', source: 'decisions', sha256: file.sha256 });
      if (replay) return replay;
      const vendorPlan = await this.resolveDecisionVendors(tx, file.vendors, false, userId);
      if (vendorPlan.unresolved.length)
        throw new ApiError(422, 'CATALOG_DECISIONS_VENDOR_UNRESOLVED', 'Поставщики из файла решений не найдены — выровняйте справочник поставщиков', {
          vendors: vendorPlan.unresolved.map((v) => ({ vendorId: v.vendorId, vendorName: v.vendorName, materialTypeId: v.materialTypeId })),
        });
      const filmIds = file.rows.flatMap((row) => row.films.map((film) => film.filmId));
      const current = new Map<number, string>();
      if (filmIds.length) {
        const films = await tx.query(`SELECT f.* FROM films f WHERE f.film_id=ANY($1::bigint[])`, [filmIds]);
        for (const film of films.rows) current.set(Number(film.film_id), filmFingerprint(this.filmRecord(film)));
      }
      const createRows = file.rows.filter((row) => row.outcome === 'create');
      const existing = createRows.length
        ? await tx.query<{ catalog_key: string | null; ref: string | null }>(
          `SELECT catalog_key,lower(ref_key_1c::text) AS ref FROM films WHERE catalog_key=ANY($1::text[]) OR lower(ref_key_1c::text)=ANY($2::text[])`,
          [createRows.map((row) => row.catalogKey), createRows.flatMap((row) => (row.onecRefKey ? [row.onecRefKey.toLowerCase()] : []))]
        )
        : { rows: [] as Array<{ catalog_key: string | null; ref: string | null }> };
      const plan: ReplayPlan = planReplay(
        file,
        current,
        new Set(existing.rows.flatMap((row) => (row.catalog_key ? [row.catalog_key] : []))),
        new Set(existing.rows.flatMap((row) => (row.ref ? [row.ref] : []))),
      );
      const planByKey = new Map(plan.rows.map((row) => [row.catalogKey, row]));
      const createKeys = plan.rows.filter((row) => row.status === 'create').map((row) => row.catalogKey);
      const options = {
        createMissing: true,
        vendorMappings: [...vendorPlan.resolved.entries()].map(([norm, v]) => ({ supplierNorm: norm, createVendor: v.create })),
        decisions: {
          sourceBatchId: file.sourceBatchId,
          sha256: file.sha256,
          fingerprintVersion: file.fingerprintVersion,
          createKeys,
          skipped: plan.skipped,
          vendors: file.vendors,
        },
      };
      const batch = (await tx.query<{ batch_id: string }>(
        `INSERT INTO catalog_import_batches(reference_kind,status,source_kind,file_name,file_sha256,sheet_name,options,counters,created_by,request_id,correlation_id) VALUES('films','draft','file',$1,$2,'decisions',$3::jsonb,'{}'::jsonb,$4,$5,$5) RETURNING batch_id`,
        [`decisions:${file.sourceBatchId}.json`, file.sha256, json(options), userId, requestId]
      )).rows[0];
      const batchId = Number(batch.batch_id);
      let appliedRows = 0;
      let appliedFilms = 0;
      for (const row of file.rows) {
        const rowPlan = planByKey.get(row.catalogKey)!;
        const vendor = vendorPlan.resolved.get(row.supplierNorm);
        const status = rowPlan.status === 'skipped' ? 'skipped' : 'ok';
        const inserted = await tx.query<{ row_id: string }>(
          `INSERT INTO catalog_import_rows(batch_id,row_no,name_original,name_full,supplier,nomenclature_type,unit,nomenclature_category,target_name,catalog_key,vendor_id,ref_key_1c,row_status,issue,onec_source_key,canonical_film_id,canonical_film_texture,canonical_film_type_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING row_id`,
          [
            batchId, row.rowNo, row.nameOriginal, row.nameFull, row.supplier, row.nomenclatureType, row.unit,
            row.nomenclatureCategory, row.targetName, row.catalogKey, vendor?.vendorId ?? null, row.onecRefKey,
            status, rowPlan.issue, row.onecRefKey, rowPlan.canonicalFilmId,
            rowPlan.status === 'apply' ? row.canonicalFilmTexture : null,
            rowPlan.status === 'apply' ? row.canonicalFilmTypeId : null,
          ]
        );
        const rowId = Number(inserted.rows[0].row_id);
        if (rowPlan.status !== 'apply') continue;
        appliedRows += 1;
        for (const film of rowPlan.films) {
          appliedFilms += 1;
          await tx.query(
            `INSERT INTO catalog_import_matches(batch_id,film_id,row_id,match_status,score,candidates,fingerprint) VALUES($1,$2,$3,'confirmed',1,NULL,$4)`,
            [batchId, film.filmId, rowId, current.get(film.filmId)]
          );
        }
      }
      const counters = {
        rows: file.rows.length,
        rowsOk: plan.rows.filter((row) => row.status !== 'skipped').length,
        rowsInvalid: 0,
        rowsSkipped: plan.rows.filter((row) => row.status === 'skipped').length,
        films: appliedFilms,
        linked: 0, auto: 0, suggested: 0, confirmed: appliedFilms, manual: 0, none: 0, unchanged: 0,
        toRename: appliedFilms,
        toMerge: Math.max(0, appliedFilms - appliedRows),
        toCreate: createKeys.length,
        unresolvedGroups: 0,
        decisionsSkipped: plan.skipped.length,
      };
      await tx.query(`UPDATE catalog_import_batches SET counters=$2::jsonb WHERE batch_id=$1`, [batchId, json(counters)]);
      await auditService.record(tx, {
        event: 'catalog_import.created',
        entityType: 'catalog_import_batch',
        entityId: batchId,
        actorUserId: userId,
        requestId,
        source: 'backend-catalog-import',
        statusField: 'status',
        statusCode: 'draft',
        after: { sourceKind: 'decisions', counters },
        metadata: {
          referenceKind: 'films',
          sourceKind: 'decisions',
          fileSha256: file.sha256,
          decisionsSourceBatchId: file.sourceBatchId,
          rowsCount: file.rows.length,
          appliedFilms,
          createRows: createKeys.length,
          skipped: plan.skipped.length,
          version: 1,
          correlationId: requestId,
        },
      });
      await this.enqueue(tx, batchId, 'created', requestId, userId);
      const result = await this.getBatchFrom(tx, batchId);
      await this.complete(tx, key, result);
      return result;
    });
  }

  private async createSnapshot(input: {
    sourceKind: 'file' | 'onec_mirror';
    rows?: Array<
      ReturnType<typeof validateCatalogRows>[number] & {
        onecSourceKey?: string;
        onecRowHash?: string;
        refKey1c?: string;
      }
    >;
    fileName?: string;
    fileSha256?: string;
    sheetName?: string;
    sourceId?: number;
    categoryKey?: string;
    userId: number;
    requestId: string;
    key: string;
    requestShape: unknown;
    prepareRows?: () => Promise<Array<ReturnType<typeof validateCatalogRows>[number] & {
      onecSourceKey?: string;
      onecRowHash?: string;
      refKey1c?: string;
    }>>;
  }) {
    return this.db.transaction(async (tx) => {
      const replay = await this.claim(
        tx,
        input.key,
        'catalog_import.create',
        input.userId,
        input.requestShape
      );
      if (replay) return replay;
      const sourceRows = input.prepareRows ? await input.prepareRows() : input.rows;
      if (!sourceRows) throw validation('Catalog rows are required');
      const vendors = await this.resolveVendors(
        tx,
        sourceRows.map((r) => r.supplier)
      );
      const batch = (
        await tx.query<{ batch_id: string }>(
          `INSERT INTO catalog_import_batches(reference_kind,status,source_kind,file_name,file_sha256,sheet_name,onec_source_id,onec_category_key,options,counters,created_by,request_id,correlation_id) VALUES('films','draft',$1,$2,$3,$4,$5,$6,'{"createMissing":true}'::jsonb,'{}'::jsonb,$7,$8,$8) RETURNING batch_id`,
          [
            input.sourceKind,
            input.fileName ?? null,
            input.fileSha256 ?? null,
            input.sheetName ?? null,
            input.sourceId ?? null,
            input.categoryKey ?? null,
            input.userId,
            input.requestId,
          ]
        )
      ).rows[0];
      const inserted: ImportRow[] = [];
      for (const row of sourceRows) {
        let status = row.rowStatus as 'ok' | 'invalid' | 'skipped';
        let issue = row.issue;
        if (
          status === 'ok' &&
          normalizeUnit(row.unit) !== 'пог м'
        ) {
          status = 'skipped';
          issue = 'Единица не «пог. м»';
        }
        if (
          status === 'ok' &&
          row.nomenclatureCategory?.toLocaleLowerCase('ru-RU') !==
            'пленка пвх для мдф'
        ) {
          status = 'skipped';
          issue = `Нет обработчика для категории ${
            row.nomenclatureCategory ?? '—'
          }`;
        }
        const vendor = vendors.find(
          (v) => v.supplierNorm === supplierNorm(row.supplier)
        );
        let refKey = row.refKey1c ?? null;
        if (input.sourceKind === 'file' && status === 'ok') {
          const lookup = await this.findFileRefKey(
            tx,
            row.nameFull,
            row.nomenclatureCategory,
            row.catalogKey
          );
          refKey = lookup.key;
          if (lookup.warning)
            issue = [issue, lookup.warning].filter(Boolean).join('; ');
        }
        const added = (
          await tx.query<{ row_id: string }>(
            `INSERT INTO catalog_import_rows(batch_id,row_no,name_original,name_full,supplier,nomenclature_type,unit,nomenclature_category,target_name,catalog_key,vendor_id,ref_key_1c,row_status,issue,onec_source_key,onec_row_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING row_id`,
            [
              batch.batch_id,
              row.rowNo,
              row.nameOriginal,
              row.nameFull,
              row.supplier,
              row.nomenclatureType,
              row.unit,
              row.nomenclatureCategory,
              row.targetName,
              row.catalogKey,
              vendor?.vendorId ?? null,
              refKey,
              status,
              issue,
              row.onecSourceKey ?? null,
              row.onecRowHash ?? null,
            ]
          )
        ).rows[0];
        inserted.push({
          ...row,
          rowId: Number(added.row_id),
          rowStatus: status,
          issue,
          vendorId: vendor?.vendorId ?? null,
          refKey1c: refKey,
          canonicalFilmId: null,
          canonicalFilmTexture: null,
          canonicalFilmTypeId: null,
          propertyConflict: null,
        });
      }
      const films = await this.loadFilms(tx);
      const mappings = vendors.map((v) => ({
        supplier: v.supplier,
        supplierNorm: v.supplierNorm,
        rowsCount: sourceRows.filter(
          (r) => supplierNorm(r.supplier) === v.supplierNorm
        ).length,
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        createVendor: false,
        suggestedVendorId: v.suggestedVendorId,
      }));
      const matches = buildMatches(inserted, films, vendorMatchMap(vendors));
      assignCanonicals(inserted, matches, films);
      for (const row of inserted)
        await tx.query(
          `UPDATE catalog_import_rows SET canonical_film_id=$2,canonical_film_texture=$3,canonical_film_type_id=$4 WHERE row_id=$1`,
          [
            row.rowId,
            row.canonicalFilmId,
            row.canonicalFilmTexture,
            row.canonicalFilmTypeId,
          ]
        );
      for (const match of matches)
        await tx.query(
          `INSERT INTO catalog_import_matches(batch_id,film_id,row_id,match_status,score,candidates,fingerprint) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
          [
            batch.batch_id,
            match.filmId,
            match.rowId,
            match.matchStatus,
            match.score,
            match.candidates.length ? json(match.candidates) : null,
            match.fingerprint,
          ]
        );
      const counters = this.counts(inserted, matches, []);
      await tx.query(
        `UPDATE catalog_import_batches SET counters=$2::jsonb WHERE batch_id=$1`,
        [batch.batch_id, json(counters)]
      );
      await auditService.record(tx, {
        event: 'catalog_import.created',
        entityType: 'catalog_import_batch',
        entityId: batch.batch_id,
        actorUserId: input.userId,
        requestId: input.requestId,
        source: 'backend-catalog-import',
        statusField: 'status',
        statusCode: 'draft',
        after: { sourceKind: input.sourceKind, counters },
        metadata: {
          referenceKind: 'films',
          sourceKind: input.sourceKind,
          fileSha256: input.fileSha256 ?? null,
          fileName: input.fileName ?? null,
          sheetName: input.sheetName ?? null,
          onecSourceId: input.sourceId ?? null,
          onecCategoryKey: input.categoryKey ?? null,
          rowsCount: sourceRows.length,
          version: 1,
          correlationId: input.requestId,
        },
      });
      await this.enqueue(
        tx,
        Number(batch.batch_id),
        'created',
        input.requestId,
        input.userId
      );
      const result = await this.getBatchFrom(tx, Number(batch.batch_id));
      await this.complete(tx, input.key, result);
      return result;
    });
  }

  async list(user: { permissions: readonly string[] }, status?: string) {
    if (status && !['draft', 'applied', 'cancelled', 'reverted'].includes(status))
      throw validation('status must be a catalog import status');
    const result = await this.db.query(
      `SELECT batch_id FROM catalog_import_batches WHERE ($1::text IS NULL OR status=$1) AND ($2::boolean OR source_kind <> 'onec_mirror') ORDER BY created_at DESC LIMIT 100`,
      [status ?? null, user.permissions.includes('onec.view')]
    );
    return {
      items: await Promise.all(
        result.rows.map((row) =>
          this.getBatch(Number(row.batch_id), user.permissions)
        )
      ),
    };
  }
  async getBatch(id: number, permissions: readonly string[]) {
    const result = await this.db.query(
      `SELECT source_kind FROM catalog_import_batches WHERE batch_id=$1`,
      [id]
    );
    if (
      !result.rows[0] ||
      !canAccessSourceKind(result.rows[0].source_kind, permissions)
    )
      throw notFound();
    return this.getBatchFrom(this.db, id);
  }
  private async getBatchFrom(client: DatabaseClient, id: number) {
    const { rows: batchRows } = await client.query(
      `SELECT * FROM catalog_import_batches WHERE batch_id=$1`,
      [id]
    );
    const b = batchRows[0];
    if (!b) throw notFound();
    const v = await client.query(
      `SELECT lower(trim(r.supplier)) AS supplier_norm,min(r.supplier) AS supplier,count(*)::int AS rows_count,min(r.vendor_id)::int AS vendor_id,min(v.vendor_name) AS vendor_name,bool_or(r.vendor_id IS NULL) AS unresolved FROM catalog_import_rows r LEFT JOIN vendors v ON v.vendor_id=r.vendor_id WHERE r.batch_id=$1 GROUP BY lower(trim(r.supplier)) ORDER BY supplier`,
      [id]
    );
    const matches = await client.query(
      `SELECT match_status,count(*)::int AS n FROM catalog_import_matches WHERE batch_id=$1 GROUP BY match_status`,
      [id]
    );
    const rows = await client.query(
      `SELECT row_status,count(*)::int AS n FROM catalog_import_rows WHERE batch_id=$1 GROUP BY row_status`,
      [id]
    );
    const category = await client.query(
      `SELECT min(nomenclature_category) AS category_name FROM catalog_import_rows WHERE batch_id=$1`,
      [id]
    );
    const counters = this.countsFrom(b.counters, rows.rows, matches.rows);
    const savedOptions = b.options as {
      createMissing: boolean;
      vendorMappings?: Array<{ supplierNorm: string; createVendor: boolean }>;
    };
    const savedMappings = new Map(
      (savedOptions.vendorMappings ?? []).map((m) => [m.supplierNorm, m])
    );
    const vendorMappings = v.rows.map((r) => ({
      supplier: r.supplier,
      supplierNorm: r.supplier_norm,
      rowsCount: Number(r.rows_count),
      vendorId: r.vendor_id === null ? null : Number(r.vendor_id),
      vendorName: r.vendor_name,
      createVendor: savedMappings.get(r.supplier_norm)?.createVendor ?? false,
      suggestedVendorId: null,
    }));
    const blockerList = await this.computeBlockers(client, id, savedOptions);
    return {
      id: Number(b.batch_id),
      kind: 'films',
      sourceKind: b.source_kind,
      status: b.status,
      version: Number(b.version),
      fileName: b.file_name,
      fileSha256: b.file_sha256,
      sheetName: b.sheet_name,
      onecSourceId: b.onec_source_id === null ? null : Number(b.onec_source_id),
      onecCategoryKey: b.onec_category_key,
      onecCategoryName:
        b.source_kind === 'onec_mirror'
          ? category.rows[0]?.category_name ?? null
          : null,
      options: b.options,
      counters,
      vendorMappings,
      canApply: b.status === 'draft' && blockerList.length === 0,
      blockers: blockerList,
      createdAt: new Date(b.created_at).toISOString(),
      createdByName: null,
      appliedAt: b.applied_at ? new Date(b.applied_at).toISOString() : null,
      appliedByName: null,
      revertedAt: b.reverted_at ? new Date(b.reverted_at).toISOString() : null,
      revertedByName: null,
    };
  }
  private async computeBlockers(
    client: DatabaseClient,
    id: number,
    saved: unknown
  ) {
    const r = await client.query(
      `SELECT 1 FROM catalog_import_matches WHERE batch_id=$1 AND match_status='suggested' LIMIT 1`,
      [id]
    );
    const mappings =
      (
        saved as {
          vendorMappings?: Array<{
            supplierNorm: string;
            createVendor: boolean;
          }>;
        } | null
      )?.vendorMappings ?? [];
    const autoCreated = new Set(
      mappings.filter((m) => m.createVendor).map((m) => m.supplierNorm)
    );
    const vendor = await client.query(
      `SELECT DISTINCT lower(trim(supplier)) supplier_norm FROM catalog_import_rows WHERE batch_id=$1 AND row_status='ok' AND vendor_id IS NULL`,
      [id]
    );
    const unresolved = vendor.rows.some(
      (row) => !autoCreated.has(String(row.supplier_norm))
    );
    const conflicts = await client.query(
      `SELECT 1 FROM catalog_import_rows WHERE batch_id=$1 AND row_status='ok' AND canonical_film_texture IS NULL AND canonical_film_id IS NOT NULL AND EXISTS(SELECT 1 FROM catalog_import_matches m JOIN films f ON f.film_id=m.film_id WHERE m.batch_id=$1 AND m.row_id=catalog_import_rows.row_id AND (f.film_texture IS DISTINCT FROM (SELECT f2.film_texture FROM films f2 WHERE f2.film_id=catalog_import_rows.canonical_film_id) OR (f.film_type_id IS DISTINCT FROM (SELECT f2.film_type_id FROM films f2 WHERE f2.film_id=catalog_import_rows.canonical_film_id) AND (SELECT lower(ft.film_type_name) FROM film_types ft WHERE ft.film_type_id=f.film_type_id) <> 'нд'))) LIMIT 1`,
      [id]
    );
    const list: string[] = [];
    if (r.rows.length) list.push('Есть неподтверждённые предположения');
    if (unresolved) list.push('Не сопоставлены поставщики');
    if (conflicts.rows.length) list.push('Не разрешены конфликты свойств');
    return list;
  }
  async rows(
    id: number,
    permissions: readonly string[],
    query: Record<string, string | undefined>
  ) {
    await this.getBatch(id, permissions);
    if (query.status && !['ok', 'invalid', 'skipped'].includes(query.status))
      throw validation('status must be ok, invalid, or skipped');
    if (query.conflict && query.conflict !== 'true' && query.conflict !== 'false')
      throw validation('conflict must be true or false');
    if (query.search && query.search.length > 200) throw validation('search is too long');
    const { limit, offset } = parsePagination(query);
    const { rows } = await this.db.query(
      `WITH grouped AS (SELECT r.*,COALESCE(array_agg(DISTINCT m.film_id) FILTER(WHERE m.film_id IS NOT NULL),'{}') AS matched_film_ids,array_agg(DISTINCT f.film_texture) FILTER(WHERE f.film_id IS NOT NULL) AS textures,array_agg(DISTINCT f.film_type_id) FILTER(WHERE f.film_id IS NOT NULL AND lower(ft.film_type_name)<>'нд') AS film_types,(count(DISTINCT f.film_texture)>1 OR count(DISTINCT f.film_type_id) FILTER(WHERE lower(ft.film_type_name)<>'нд')>1) AS has_conflict FROM catalog_import_rows r LEFT JOIN catalog_import_matches m ON m.batch_id=r.batch_id AND m.row_id=r.row_id LEFT JOIN films f ON f.film_id=m.film_id LEFT JOIN film_types ft ON ft.film_type_id=f.film_type_id WHERE r.batch_id=$1 AND ($2::text IS NULL OR r.row_status=$2) AND ($3::text IS NULL OR r.target_name ILIKE '%'||$3||'%') GROUP BY r.row_id) SELECT *,count(*) OVER() AS total FROM grouped WHERE ($4::text IS NULL OR ($4='true' AND has_conflict) OR ($4='false' AND NOT has_conflict)) ORDER BY row_no LIMIT $5 OFFSET $6`,
      [
        id,
        query.status ?? null,
        query.search ?? null,
        query.conflict === 'true' || query.conflict === 'false'
          ? query.conflict
          : null,
        limit,
        offset,
      ]
    );
    const items = rows.map((r) => {
      const textures = (r.textures ?? []).filter(
        (v: unknown): v is boolean => typeof v === 'boolean'
      );
      const filmTypes = (r.film_types ?? []).map(Number);
      const propertyConflict =
        textures.length > 1 || filmTypes.length > 1
          ? { filmTexture: textures, filmTypeIds: filmTypes }
          : null;
      return {
        rowId: Number(r.row_id),
        rowNo: Number(r.row_no),
        nameOriginal: r.name_original,
        nameFull: r.name_full,
        supplier: r.supplier,
        nomenclatureType: r.nomenclature_type,
        unit: r.unit,
        nomenclatureCategory: r.nomenclature_category,
        targetName: r.target_name,
        rowStatus: r.row_status,
        issue: r.issue,
        vendorId: r.vendor_id === null ? null : Number(r.vendor_id),
        refKey1c: r.ref_key_1c,
        canonicalFilmId:
          r.canonical_film_id === null ? null : Number(r.canonical_film_id),
        matchedFilmIds: (r.matched_film_ids ?? []).map(Number),
        propertyConflict,
        canonicalFilmTexture: r.canonical_film_texture,
        canonicalFilmTypeId:
          r.canonical_film_type_id === null
            ? null
            : Number(r.canonical_film_type_id),
      };
    });
    return { total: rows[0] ? Number(rows[0].total) : 0, items };
  }
  async matches(
    id: number,
    permissions: readonly string[],
    query: Record<string, string | undefined>
  ) {
    await this.getBatch(id, permissions);
    if (query.status && !['linked', 'auto', 'suggested', 'confirmed', 'manual', 'none', 'unchanged'].includes(query.status))
      throw validation('status must be a match status');
    if (query.vendorId) parsePositiveQuery(query.vendorId, 'vendorId');
    if (query.rowId) parsePositiveQuery(query.rowId, 'rowId');
    if (query.search && query.search.length > 200) throw validation('search is too long');
    const { limit, offset } = parsePagination(query);
    const { rows } = await this.db.query(
      `SELECT m.*,f.film_name,f.vendor_id,f.is_active,f.canonical_film_id,(SELECT vendor_name FROM vendors v WHERE v.vendor_id=f.vendor_id) vendor_name,(SELECT count(*)::int FROM order_details d WHERE d.film_id=f.film_id) details,(SELECT max(d.updated_at) FROM order_details d WHERE d.film_id=f.film_id) last_used_at,r.target_name,count(*) OVER() AS total FROM catalog_import_matches m JOIN films f USING(film_id) LEFT JOIN catalog_import_rows r USING(row_id) WHERE m.batch_id=$1 AND ($2::text IS NULL OR m.match_status=$2) AND ($3::int IS NULL OR f.vendor_id=$3) AND ($4::bigint IS NULL OR m.row_id=$4) AND ($5::text IS NULL OR f.film_name ILIKE '%'||$5||'%') ORDER BY f.film_name LIMIT $6 OFFSET $7`,
      [
        id,
        query.status ?? null,
        query.vendorId ? Number(query.vendorId) : null,
        query.rowId ? Number(query.rowId) : null,
        query.search ?? null,
        limit,
        offset,
      ]
    );
    return {
      total: rows[0] ? Number(rows[0].total) : 0,
      items: rows.map((r) => ({
        filmId: Number(r.film_id),
        filmName: r.film_name,
        vendorName: r.vendor_name,
        isActive: r.is_active,
        canonicalFilmId:
          r.canonical_film_id === null ? null : Number(r.canonical_film_id),
        usage: {
          details: Number(r.details),
          lastUsedAt: r.last_used_at
            ? new Date(r.last_used_at).toISOString()
            : null,
        },
        matchStatus: r.match_status,
        rowId: r.row_id === null ? null : Number(r.row_id),
        rowTargetName: r.target_name,
        score: r.score === null ? null : Number(r.score),
        candidates: r.candidates ?? [],
      })),
    };
  }

  async patch(
    id: number,
    permissions: readonly string[],
    body: { version: number; actions: CatalogAction[] },
    userId: number,
    requestId: string,
    key: string
  ) {
    await this.getBatch(id, permissions);
    return this.db.transaction(async (tx) => {
      const replay = await this.claim(
        tx,
        key,
        'catalog_import.updated',
        userId,
        { id, ...body },
        String(id)
      );
      if (replay) return replay;
      const batch = await this.lockDraft(tx, id, body.version);
      if ((batch.options as { decisions?: unknown } | null)?.decisions)
        throw new ApiError(409, 'CATALOG_IMPORT_READ_ONLY', 'Пакет из файла решений не редактируется — примените или отмените его');
      const before = {
        status: batch.status,
        version: Number(batch.version),
        options: batch.options,
        counters: batch.counters,
      };
      const rows = await this.loadRows(tx, id),
        films = await this.loadFilms(tx),
        matches = await this.loadMatches(tx, id),
        vendors = await this.loadVendorMappings(tx, id);
      const options = batch.options as {
        createMissing: boolean;
        vendorMappings?: Array<{ supplierNorm: string; createVendor: boolean }>;
      };
      const vendorIds = [
        ...new Set(
          body.actions.flatMap((action) =>
            action.type === 'setVendor' ? [action.vendorId] : []
          )
        ),
      ];
      if (vendorIds.length) {
        const result = await tx.query(
          `SELECT count(*)::int n FROM vendors WHERE vendor_id=ANY($1::smallint[])`,
          [vendorIds]
        );
        if (Number(result.rows[0]?.n) !== vendorIds.length)
          throw new ApiError(400, 'VALIDATION_FAILED', 'Поставщик не найден');
      }
      const filmTypeIds = [
        ...new Set(
          body.actions.flatMap((action) =>
            action.type === 'setCanonicalProperties' ? [action.filmTypeId] : []
          )
        ),
      ];
      if (filmTypeIds.length) {
        const result = await tx.query(
          `SELECT count(*)::int n FROM film_types WHERE film_type_id=ANY($1::smallint[])`,
          [filmTypeIds]
        );
        if (Number(result.rows[0]?.n) !== filmTypeIds.length)
          throw new ApiError(400, 'VALIDATION_FAILED', 'Тип плёнки не найден');
      }
      try {
        applyPatchActions(rows, matches, films, vendors, body.actions, options);
      } catch (error) {
        throw new ApiError(400, 'VALIDATION_FAILED', String(error));
      }
      if (body.actions.some((action) => action.type === 'setVendor')) {
        // Названия поставщиков — из справочника, как при создании черновика (не из плёнок: у
        // поставщика может не быть своих плёнок, и ключ из названия плёнки на «нд» терялся).
        const mappedIds = [...new Set(vendors.flatMap((vendor) => (vendor.vendorId === null ? [] : [vendor.vendorId])))];
        const names = new Map(
          (
            await tx.query<{ vendor_id: number; vendor_name: string }>(
              `SELECT vendor_id,vendor_name FROM vendors WHERE vendor_id=ANY($1::smallint[])`,
              [mappedIds]
            )
          ).rows.map((row) => [Number(row.vendor_id), row.vendor_name])
        );
        const vendorBySupplier = vendorMatchMap(
          vendors.map((vendor) => ({
            ...vendor,
            vendorName: vendor.vendorId === null ? null : names.get(vendor.vendorId) ?? null,
          }))
        );
        const explicitFilmIds = new Set(
          body.actions.flatMap((action) =>
            action.type === 'setMatch' || action.type === 'confirmMatch'
              ? [action.filmId!]
              : []
          )
        );
        const refreshed = refreshMatches(
          rows,
          films,
          vendorBySupplier,
          matches,
          explicitFilmIds
        );
        matches.splice(0, matches.length, ...refreshed);
      }
      assignCanonicals(rows, matches, films);
      options.vendorMappings = vendors.map((v) => ({
        supplierNorm: v.supplierNorm,
        createVendor: v.createVendor,
      }));
      for (const row of rows)
        await tx.query(
          `UPDATE catalog_import_rows SET vendor_id=$2,canonical_film_id=$3,canonical_film_texture=$4,canonical_film_type_id=$5 WHERE row_id=$1`,
          [
            row.rowId,
            row.vendorId,
            row.canonicalFilmId,
            row.canonicalFilmTexture,
            row.canonicalFilmTypeId,
          ]
        );
      for (const m of matches)
        await tx.query(
          `UPDATE catalog_import_matches SET row_id=$3,match_status=$4,score=$5,candidates=$6::jsonb WHERE batch_id=$1 AND film_id=$2`,
          [
            id,
            m.filmId,
            m.rowId,
            m.matchStatus,
            m.score,
            m.candidates.length ? json(m.candidates) : null,
          ]
        );
      const counters = this.counts(rows, matches, []);
      await tx.query(
        `UPDATE catalog_import_batches SET version=version+1,options=$2::jsonb,counters=$3::jsonb WHERE batch_id=$1`,
        [id, json(options), json(counters)]
      );
      await auditService.record(tx, {
        event: 'catalog_import.updated',
        entityType: 'catalog_import_batch',
        entityId: id,
        actorUserId: userId,
        requestId,
        source: 'backend-catalog-import',
        statusField: 'status',
        statusCode: 'draft',
        before,
        after: {
          status: 'draft',
          version: body.version + 1,
          options,
          counters,
        },
        diff: {
          version: { before: body.version, after: body.version + 1 },
          optionsChanged: json(before.options) !== json(options),
        },
        metadata: {
          patchAction: body.actions.map((a) => a.type),
          version: body.version + 1,
          correlationId: requestId,
        },
      });
      await this.enqueue(tx, id, 'updated', requestId, userId, body.version + 1);
      const result = await this.getBatchFrom(tx, id);
      await this.complete(tx, key, result);
      return result;
    });
  }

  async apply(
    id: number,
    permissions: readonly string[],
    version: number,
    userId: number,
    requestId: string,
    key: string
  ) {
    await this.getBatch(id, permissions);
    return this.db.transaction(async (tx) => {
      const replay = await this.claim(
        tx,
        key,
        'catalog_import.applied',
        userId,
        { version, id },
        String(id)
      );
      if (replay) return replay;
      const batch = await this.lockDraft(tx, id, version);
      const block = await this.computeBlockers(tx, id, batch.options);
      if (block.length)
        throw new ApiError(
          422,
          'CATALOG_IMPORT_UNRESOLVED',
          'Черновик требует решений',
          { blockers: block }
        );
      const matches = await this.loadMatches(tx, id),
        rows = await this.loadRows(tx, id);
      const targetIds = [
        ...new Set(
          matches
            .filter(
              (m) =>
                m.rowId !== null &&
                ['linked', 'auto', 'confirmed', 'manual'].includes(
                  m.matchStatus
                )
            )
            .map((m) => m.filmId)
        ),
      ].sort((a, b) => a - b);
      const locked = await tx.query(
        `SELECT f.*,v.vendor_name,(SELECT film_type_name FROM film_types ft WHERE ft.film_type_id=f.film_type_id) AS film_type_name FROM films f LEFT JOIN vendors v USING(vendor_id) WHERE f.film_id=ANY($1::bigint[]) OR f.film_id IN (SELECT canonical_film_id FROM films WHERE film_id=ANY($1::bigint[])) ORDER BY f.film_id FOR NO KEY UPDATE OF f`,
        [targetIds]
      );
      const byId = new Map(locked.rows.map((f) => [Number(f.film_id), f]));
      const impacted = [...byId.keys()].sort((a, b) => a - b);
      await this.setChangeSettings(tx, userId, id, 'catalog_import');
      const conflicts: Array<{
        filmId?: number;
        rowId?: number;
        reason: string;
      }> = [];
      for (const m of matches.filter((x) => byId.has(x.filmId))) {
        if (
          filmFingerprint(this.filmRecord(byId.get(m.filmId)!)) !==
          m.fingerprint
        )
          conflicts.push({ filmId: m.filmId, reason: 'fingerprint_changed' });
      }
      const targetNames = new Set<string>();
      const refKeys = new Set<string>();
      for (const row of rows.filter((r) => r.rowStatus === 'ok')) {
        const group = matches.filter(
          (m) =>
            m.rowId === row.rowId &&
            ['linked', 'auto', 'confirmed', 'manual'].includes(m.matchStatus)
        );
        const ids = group.map((m) => m.filmId);
        const supplierIdentity = row.vendorId === null
          ? `supplier:${supplierNorm(row.supplier)}`
          : `vendor:${row.vendorId}`;
        const nameIdentity = `${supplierIdentity}\0${row.targetName}`;
        if (targetNames.has(nameIdentity))
          conflicts.push({ rowId: row.rowId, reason: 'package_name_vendor_conflict' });
        targetNames.add(nameIdentity);
        if (row.vendorId !== null) {
          const duplicate = await tx.query(
            `SELECT film_id FROM films WHERE canonical_film_id IS NULL AND vendor_id=$1 AND film_name=$2 AND NOT (film_id=ANY($3::bigint[])) LIMIT 1`,
            [row.vendorId, row.targetName, ids]
          );
          if (duplicate.rows.length)
            conflicts.push({
              rowId: row.rowId,
              reason: 'film_name_vendor_conflict',
            });
        }
        if (row.catalogKey) {
          const duplicate = await tx.query(
            `SELECT film_id FROM films WHERE catalog_key=$1 AND NOT (film_id=ANY($2::bigint[])) LIMIT 1`,
            [row.catalogKey, ids]
          );
          if (duplicate.rows.length)
            conflicts.push({
              rowId: row.rowId,
              reason: 'catalog_key_conflict',
            });
        }
        if (row.refKey1c) {
          if (refKeys.has(row.refKey1c))
            conflicts.push({ rowId: row.rowId, reason: 'package_ref_key_conflict' });
          refKeys.add(row.refKey1c);
          const duplicate = await tx.query(
            `SELECT film_id FROM films WHERE ref_key_1c=$1 AND NOT (film_id=ANY($2::bigint[])) LIMIT 1`,
            [row.refKey1c, ids]
          );
          if (duplicate.rows.length)
            conflicts.push({ rowId: row.rowId, reason: 'ref_key_conflict' });
        }
        const canonical = row.canonicalFilmId ?? group[0]?.filmId;
        // Ключ 1С уже связанной плёнки не перезаписывается и не снимается (любой импорт).
        for (const match of group) {
          const f = byId.get(match.filmId);
          if (!f) continue;
          const filmKey = f.ref_key_1c ? String(f.ref_key_1c).toLowerCase() : null;
          if (match.filmId === canonical) {
            if (filmKey !== null && filmKey !== (row.refKey1c ? String(row.refKey1c).toLowerCase() : null))
              conflicts.push({ filmId: match.filmId, rowId: row.rowId, reason: 'ref_key_conflict' });
          } else if (filmKey !== null || f.catalog_key) {
            conflicts.push({ filmId: match.filmId, rowId: row.rowId, reason: 'duplicate_has_catalog_key' });
          }
        }
        if (canonical) {
          for (const match of group) {
            const f = byId.get(match.filmId);
            if (!f) continue;
            const oldResolved = Number(f.canonical_film_id ?? f.film_id);
            if (oldResolved !== canonical)
              await this.assertNoStock(
                tx,
                [match.filmId, oldResolved],
                conflicts
              );
          }
        }
      }
      if (conflicts.length)
        throw new ApiError(
          409,
          'CATALOG_IMPORT_CONFLICT',
          'Записи изменились или нарушают ограничения',
          { conflicts }
        );
      const createdVendorIds: number[] = [];
      const createdFilmIds: number[] = [];
      const decisions = (batch.options as { decisions?: { createKeys: string[]; vendors: DecisionVendor[] } } | null)?.decisions ?? null;
      if (decisions) {
        // Поставщики пакета повтора — окончательно здесь, атомарно: с экспортированными названием и типом.
        const plan = await this.resolveDecisionVendors(tx, decisions.vendors, true, userId);
        if (plan.unresolved.length)
          throw new ApiError(409, 'CATALOG_IMPORT_CONFLICT', 'Поставщики из файла решений не найдены', {
            conflicts: plan.unresolved.map((v) => ({ reason: 'vendor_unresolved', vendorName: v.vendorName })),
          });
        for (const [norm, resolved] of plan.resolved) {
          if (resolved.vendorId === null) continue;
          if (resolved.inserted) createdVendorIds.push(resolved.vendorId);
          await tx.query(
            `INSERT INTO vendor_import_aliases(source_norm,vendor_id,created_by) VALUES($1,$2,$3) ON CONFLICT(source_norm) DO UPDATE SET vendor_id=EXCLUDED.vendor_id,created_by=EXCLUDED.created_by`,
            [norm, resolved.vendorId, userId]
          );
          for (const row of rows)
            if (supplierNorm(row.supplier) === norm) row.vendorId = resolved.vendorId;
        }
      }
      const vendors = decisions ? [] : await this.loadVendorMappings(tx, id);
      for (const mapping of vendors) {
        let vendorId = mapping.vendorId;
        if (vendorId === null && mapping.createVendor) {
          const materialType = await tx.query(
            `SELECT material_type_id FROM vendors GROUP BY material_type_id ORDER BY count(*) DESC,material_type_id LIMIT 1`
          );
          if (!materialType.rows[0])
            throw new ApiError(
              409,
              'CATALOG_IMPORT_CONFLICT',
              'Не найден тип поставщика для создания',
              { conflicts: [{ reason: 'vendor_material_type_missing' }] }
            );
          const newVendor = await tx.query<{ vendor_id: string }>(
            `INSERT INTO vendors(vendor_name,material_type_id,created_by) VALUES($1,$2,$3) RETURNING vendor_id`,
            [mapping.supplier, materialType.rows[0].material_type_id, userId]
          );
          vendorId = Number(newVendor.rows[0].vendor_id);
          createdVendorIds.push(vendorId);
        }
        if (vendorId !== null) {
          await tx.query(
            `INSERT INTO vendor_import_aliases(source_norm,vendor_id,created_by) VALUES($1,$2,$3) ON CONFLICT(source_norm) DO UPDATE SET vendor_id=EXCLUDED.vendor_id,created_by=EXCLUDED.created_by`,
            [mapping.supplierNorm, vendorId, userId]
          );
          for (const row of rows)
            if (supplierNorm(row.supplier) === mapping.supplierNorm)
              row.vendorId = vendorId;
        }
      }
      for (const row of rows.filter(
        (r) => r.rowStatus === 'ok' && r.vendorId !== null
      )) {
        const ids = matches
          .filter((m) => m.rowId === row.rowId)
          .map((m) => m.filmId);
        const duplicate = await tx.query(
          `SELECT film_id FROM films WHERE canonical_film_id IS NULL AND vendor_id=$1 AND film_name=$2 AND NOT (film_id=ANY($3::bigint[])) LIMIT 1`,
          [row.vendorId, row.targetName, ids]
        );
        if (duplicate.rows.length)
          conflicts.push({
            rowId: row.rowId,
            reason: 'film_name_vendor_conflict',
          });
      }
      if (conflicts.length)
        throw new ApiError(
          409,
          'CATALOG_IMPORT_CONFLICT',
          'Записи изменились или нарушают ограничения',
          { conflicts }
        );
      for (const row of rows.filter((r) => r.rowStatus === 'ok')) {
        const group = matches.filter(
          (m) =>
            m.rowId === row.rowId &&
            ['linked', 'auto', 'confirmed', 'manual'].includes(m.matchStatus)
        );
        if (!group.length) {
          if (!(batch.options as { createMissing: boolean }).createMissing)
            continue;
          // Пакет повтора создаёт только позиции, созданные на stage.
          if (decisions && !decisions.createKeys.includes(row.catalogKey)) continue;
          const vendorId = row.vendorId;
          if (vendorId === null) continue;
          const nd = await tx.query<{ film_type_id: number }>(
            `SELECT film_type_id FROM film_types WHERE lower(film_type_name)='нд' ORDER BY film_type_id LIMIT 1`
          );
          if (!nd.rows[0])
            throw new ApiError(
              409,
              'CATALOG_IMPORT_CONFLICT',
              'Не найден тип плёнки «нд»',
              { conflicts: [{ rowId: row.rowId, reason: 'no_type_missing' }] }
            );
          const inserted = await tx.query<{ film_id: string }>(
            `INSERT INTO films(film_name,vendor_id,film_type_id,film_texture,is_active,sort_order,created_by,edited_by,nomenclature_type,nomenclature_category,catalog_key,ref_key_1c) VALUES($1,$2,$3,false,true,100,$4,$4,$5,$6,$7,$8) RETURNING film_id`,
            [
              row.targetName,
              vendorId,
              nd.rows[0].film_type_id,
              userId,
              row.nomenclatureType,
              row.nomenclatureCategory,
              row.catalogKey,
              row.refKey1c,
            ]
          );
          const filmId = Number(inserted.rows[0].film_id);
          createdFilmIds.push(filmId);
          const afterBusiness = normalizeFilmBusinessFields({
            film_name: row.targetName,
            vendor_id: vendorId,
            film_type_id: Number(nd.rows[0].film_type_id),
            film_texture: false,
            is_active: true,
            sort_order: 100,
            canonical_film_id: null,
            catalog_key: row.catalogKey,
            ref_key_1c: row.refKey1c,
            nomenclature_type: row.nomenclatureType,
            nomenclature_category: row.nomenclatureCategory,
          });
          const after = { ...afterBusiness, created: true, filmId };
          await tx.query(
            `INSERT INTO catalog_import_matches(batch_id,film_id,row_id,match_status,fingerprint,before,after) VALUES($1,$2,$3,'manual',$4,NULL,$5::jsonb)`,
            [id, filmId, row.rowId, filmFingerprint(afterBusiness), json(after)]
          );
          continue;
        }
        const canonical = row.canonicalFilmId ?? group[0].filmId;
        const vendorId = row.vendorId;
        if (vendorId === null) continue;
        const targetProps = byId.get(canonical);
        if (!targetProps) continue;
        const typeId =
          row.canonicalFilmTypeId ?? Number(targetProps.film_type_id);
        const texture =
          row.canonicalFilmTexture ?? Boolean(targetProps.film_texture);
        const orderedGroup = [...group].sort(
          (a, b) => Number(a.filmId === canonical) - Number(b.filmId === canonical)
        );
        for (const match of orderedGroup) {
          const f = byId.get(match.filmId);
          if (!f) continue;
          const before = this.filmRecord(f);
          const isCanon = match.filmId === canonical;
          const after = {
            ...before,
            film_name: row.targetName,
            vendor_id: vendorId,
            nomenclature_type: row.nomenclatureType,
            nomenclature_category: row.nomenclatureCategory,
            canonical_film_id: isCanon ? null : canonical,
            is_active: isCanon ? true : false,
            catalog_key: isCanon ? row.catalogKey : null,
            ref_key_1c: isCanon ? row.refKey1c : null,
            film_texture: isCanon ? texture : Boolean(f.film_texture),
            film_type_id: isCanon ? typeId : Number(f.film_type_id),
          };
          // Примечание — вне отпечатка: текущее значение под блокировкой (FOR NO KEY UPDATE выше),
          // прежнее название дописывается; «до/после» сохраняются рядом со снимком для отката.
          const noteBefore = (f.note ?? null) as string | null;
          const noteAfter = before.film_name !== row.targetName
            ? noteWithPreviousName(noteBefore, String(before.film_name))
            : noteBefore;
          await tx.query(
            `UPDATE films SET film_name=$2,vendor_id=$3,nomenclature_type=$4,nomenclature_category=$5,canonical_film_id=$6,is_active=$7,catalog_key=$8,ref_key_1c=$9,film_texture=$10,film_type_id=$11,edited_by=$12,note=$13 WHERE film_id=$1`,
            [
              match.filmId,
              after.film_name,
              after.vendor_id,
              after.nomenclature_type,
              after.nomenclature_category,
              after.canonical_film_id,
              after.is_active,
              after.catalog_key,
              after.ref_key_1c,
              after.film_texture,
              after.film_type_id,
              userId,
              noteAfter,
            ]
          );
          // note — рядом со снимком (не в отпечатке): откат вернёт его, если после применения не правили.
          await tx.query(
            `UPDATE catalog_import_matches SET before=$3::jsonb,after=$4::jsonb WHERE batch_id=$1 AND film_id=$2`,
            [id, match.filmId, json({ ...before, note: noteBefore }), json({ ...after, note: noteAfter })]
          );
        }
      }
      // Снимок поставщиков на момент применения (для файла решений): переименование поставщика
      // после применения не меняет выгружаемую идентичность.
      const usedVendors = new Map<string, number>();
      for (const row of rows)
        if (row.rowStatus === 'ok' && row.vendorId !== null) usedVendors.set(supplierNorm(row.supplier), row.vendorId);
      const vendorSnapshot = usedVendors.size
        ? (await tx.query<{ vendor_id: string; vendor_name: string; material_type_id: string | null }>(
          `SELECT vendor_id,vendor_name,material_type_id FROM vendors WHERE vendor_id=ANY($1::smallint[]) ORDER BY vendor_id FOR SHARE`,
          [[...new Set(usedVendors.values())]]
        )).rows
        : [];
      const vendorById = new Map(vendorSnapshot.map((v) => [Number(v.vendor_id), v]));
      const appliedVendors = [...usedVendors.entries()].flatMap(([norm, vendorId]) => {
        const v = vendorById.get(vendorId);
        return v ? [{
          supplierNorm: norm, vendorId, vendorName: v.vendor_name,
          materialTypeId: v.material_type_id === null ? null : Number(v.material_type_id),
          created: createdVendorIds.includes(vendorId),
        }] : [];
      });
      await tx.query(
        `UPDATE catalog_import_batches SET status='applied',applied_at=now(),applied_by=$2,version=version+1,options=options||jsonb_build_object('appliedVendors',$3::jsonb) WHERE batch_id=$1`,
        [id, userId, json(appliedVendors)]
      );
      const summary = await tx.query(
        `SELECT count(*) FILTER (WHERE after->>'created'='true')::int AS created_count,count(*) FILTER (WHERE before->>'film_name' IS DISTINCT FROM after->>'film_name')::int AS renamed_count,count(*) FILTER (WHERE after->>'canonical_film_id' IS NOT NULL)::int AS merged_count,count(*) FILTER (WHERE row_id IS NULL)::int AS unchanged_count FROM catalog_import_matches WHERE batch_id=$1`,
        [id]
      );
      const totals = summary.rows[0];
      await auditService.record(tx, {
        event: 'catalog_import.applied',
        entityType: 'catalog_import_batch',
        entityId: id,
        actorUserId: userId,
        requestId,
        source: 'backend-catalog-import',
        statusField: 'status',
        statusCode: 'applied',
        before: { status: batch.status, version: Number(batch.version) },
        after: { status: 'applied', counters: batch.counters },
        metadata: {
          referenceKind: 'films',
          renamedCount: Number(totals.renamed_count),
          mergedCount: Number(totals.merged_count),
          createdCount: Number(totals.created_count),
          unchangedCount: Number(totals.unchanged_count),
          refKeysSet: rows.filter((r) => r.refKey1c).length,
          correlationId: requestId,
        },
        relatedEntities: [
          ...impacted.map((filmId) => ({
            entityType: 'film' as const,
            entityId: filmId,
          })),
          ...createdVendorIds.map((entityId) => ({
            entityType: 'vendor' as const,
            entityId,
          })),
          ...createdFilmIds.map((entityId) => ({
            entityType: 'film' as const,
            entityId,
          })),
        ],
      });
      await this.enqueue(tx, id, 'applied', requestId, userId);
      const result = await this.getBatchFrom(tx, id);
      await this.complete(tx, key, result);
      return result;
    });
  }

  async cancel(
    id: number,
    permissions: readonly string[],
    version: number,
    userId: number,
    requestId: string,
    key: string
  ) {
    await this.getBatch(id, permissions);
    return this.db.transaction(async (tx) => {
      const replay = await this.claim(
        tx,
        key,
        'catalog_import.cancelled',
        userId,
        { version, id },
        String(id)
      );
      if (replay) return replay;
      const batch = await this.lockDraft(tx, id, version);
      await tx.query(
        `UPDATE catalog_import_batches SET status='cancelled',version=version+1 WHERE batch_id=$1`,
        [id]
      );
      await auditService.record(tx, {
        event: 'catalog_import.cancelled',
        entityType: 'catalog_import_batch',
        entityId: id,
        actorUserId: userId,
        requestId,
        source: 'backend-catalog-import',
        statusField: 'status',
        statusCode: 'cancelled',
        before: { status: batch.status, version: Number(batch.version) },
        after: { status: 'cancelled', version: version + 1 },
        metadata: { correlationId: requestId },
      });
      await this.enqueue(tx, id, 'cancelled', requestId, userId);
      const result = await this.getBatchFrom(tx, id);
      await this.complete(tx, key, result);
      return result;
    });
  }
  async revert(
    id: number,
    permissions: readonly string[],
    userId: number,
    requestId: string,
    key: string
  ) {
    await this.getBatch(id, permissions);
    return this.db.transaction(async (tx) => {
      const replay = await this.claim(
        tx,
        key,
        'catalog_import.reverted',
        userId,
        { id },
        String(id)
      );
      if (replay) return replay;
      const { rows } = await tx.query(
        `SELECT * FROM catalog_import_batches WHERE batch_id=$1 FOR UPDATE`,
        [id]
      );
      if (!rows[0] || rows[0].status !== 'applied')
        throw new ApiError(
          409,
          'CATALOG_IMPORT_NOT_DRAFT',
          'Пакет не применён'
        );
      const matches = await tx.query(
        `SELECT m.*,f.* FROM catalog_import_matches m JOIN films f USING(film_id) WHERE m.batch_id=$1 ORDER BY f.film_id FOR NO KEY UPDATE OF f`,
        [id]
      );
      const conflicts: Array<{ filmId: number; reason: string }> = [];
      for (const m of matches.rows) {
        if (m.before === null && m.after === null) continue;
        const created = m.after?.created === true;
        if (created) {
          if (filmFingerprint(this.filmRecord(m)) !== m.fingerprint)
            conflicts.push({
              filmId: Number(m.film_id),
              reason: 'fingerprint_changed',
            });
        } else if (
          !m.before ||
          filmFingerprint(this.filmRecord(m)) !== filmFingerprint(m.after)
        )
          conflicts.push({
            filmId: Number(m.film_id),
            reason: 'fingerprint_changed',
          });
        const later = await tx.query(
          `SELECT lb.batch_id FROM catalog_import_matches lm JOIN catalog_import_batches lb USING(batch_id) WHERE lm.film_id=$1 AND lb.status='applied' AND lm.after IS NOT NULL ORDER BY lb.applied_at DESC,lb.batch_id DESC LIMIT 1`,
          [m.film_id]
        );
        if (Number(later.rows[0]?.batch_id) !== id)
          conflicts.push({
            filmId: Number(m.film_id),
            reason: 'not_last_applied',
          });
        if (created)
          await this.assertNoStock(tx, [Number(m.film_id)], conflicts);
        else {
          const before = m.before as Record<string, unknown>;
          const oldResolved = Number(m.canonical_film_id ?? m.film_id);
          const restoredResolved = Number(
            before.canonical_film_id ?? m.film_id
          );
          if (oldResolved !== restoredResolved)
            await this.assertNoStock(
              tx,
              [Number(m.film_id), oldResolved],
              conflicts
            );
        }
      }
      // Итоговая уникальность (film_name, vendor_id) среди канонов после отката всей группы:
      // восстановленные записи пакета сравниваются между собой, с созданными пакетом записями
      // (они остаются каноническими, но неактивными) и с канонами вне пакета.
      const touched = matches.rows.filter((m) => m.before !== null || m.after !== null);
      const touchedIds = touched.map((m) => Number(m.film_id));
      const finalKeys = new Map<string, number>();
      const keyOf = (name: unknown, vendorId: unknown) => `${String(vendorId ?? '')}\u0000${String(name)}`;
      for (const m of touched) {
        const created = m.after?.created === true;
        const state = created ? m : (m.before as Record<string, unknown>);
        const canonicalAfterRevert = created ? m.canonical_film_id === null : state.canonical_film_id === null;
        if (!canonicalAfterRevert) continue;
        const key = keyOf(state.film_name, state.vendor_id);
        if (finalKeys.has(key)) {
          conflicts.push({ filmId: Number(m.film_id), reason: 'restored_name_conflict' });
        } else finalKeys.set(key, Number(m.film_id));
        const outside = await tx.query(
          `SELECT film_id FROM films WHERE canonical_film_id IS NULL AND NOT (film_id = ANY($1::bigint[])) AND film_name=$2 AND vendor_id IS NOT DISTINCT FROM $3 LIMIT 1`,
          [touchedIds, state.film_name, state.vendor_id]
        );
        if (outside.rows.length)
          conflicts.push({ filmId: Number(m.film_id), reason: 'restored_name_conflict' });
      }
      if (conflicts.length)
        throw new ApiError(
          409,
          'CATALOG_IMPORT_REVERT_BLOCKED',
          'Откат заблокирован',
          { conflicts }
        );
      await this.setChangeSettings(tx, userId, id, 'catalog_import_revert');
      // Порядок без промежуточных коллизий уникальных индексов: сначала записи, которые сейчас
      // являются канонами (освобождают имя/catalog_key/ref_key_1c), затем остальные, созданные — в конце.
      const ordered = matches.rows
        .filter((m) => m.before !== null || m.after !== null)
        .sort((a, b) => {
          const rank = (m: typeof a) => (m.after?.created === true ? 2 : m.canonical_film_id === null ? 0 : 1);
          return rank(a) - rank(b) || Number(a.film_id) - Number(b.film_id);
        });
      for (const m of ordered) {
        if (m.after?.created) {
          await tx.query(
            `UPDATE films SET is_active=false,edited_by=$2 WHERE film_id=$1`,
            [m.film_id, userId]
          );
          continue;
        }
        const b = m.before as Record<string, unknown>;
        const a = (m.after ?? {}) as Record<string, unknown>;
        // Примечание: только пакеты с сохранённым note (после миграции 212) и только если после
        // применения его не правили вручную; иначе остаётся текущее.
        const restoreNote = 'note' in b && 'note' in a && (m.note ?? null) === (a.note ?? null);
        await tx.query(
          `UPDATE films SET film_name=$2,vendor_id=$3,film_type_id=$4,film_texture=$5,is_active=$6,sort_order=$7,canonical_film_id=$8,catalog_key=$9,ref_key_1c=$10,nomenclature_type=$11,nomenclature_category=$12,edited_by=$13,note=CASE WHEN $15::boolean THEN $14 ELSE note END WHERE film_id=$1`,
          [
            m.film_id,
            b.film_name,
            b.vendor_id,
            b.film_type_id,
            b.film_texture,
            b.is_active,
            b.sort_order,
            b.canonical_film_id,
            b.catalog_key,
            b.ref_key_1c,
            b.nomenclature_type,
            b.nomenclature_category,
            userId,
            (b.note ?? null) as string | null,
            restoreNote,
          ]
        );
      }
      await tx.query(
        `UPDATE catalog_import_batches SET status='reverted',reverted_at=now(),reverted_by=$2,version=version+1 WHERE batch_id=$1`,
        [id, userId]
      );
      await auditService.record(tx, {
        event: 'catalog_import.reverted',
        entityType: 'catalog_import_batch',
        entityId: id,
        actorUserId: userId,
        requestId,
        source: 'backend-catalog-import',
        statusField: 'status',
        statusCode: 'reverted',
        before: { status: rows[0].status, version: Number(rows[0].version) },
        after: { status: 'reverted', version: Number(rows[0].version) + 1 },
        metadata: { referenceKind: 'films', correlationId: requestId },
        relatedEntities: [
          ...matches.rows.filter((m) => m.before !== null || m.after !== null).map((m) => ({
          entityType: 'film',
          entityId: Number(m.film_id),
          })),
          ...(await tx.query<{ vendor_id: string }>(
            `SELECT DISTINCT a.vendor_id FROM vendor_import_aliases a JOIN catalog_import_rows r ON lower(trim(r.supplier))=a.source_norm WHERE r.batch_id=$1 AND a.created_by=$2`,
            [id, rows[0].applied_by]
          )).rows.map((vendor) => ({ entityType: 'vendor', entityId: Number(vendor.vendor_id) })),
        ],
      });
      await this.enqueue(tx, id, 'reverted', requestId, userId);
      const result = await this.getBatchFrom(tx, id);
      await this.complete(tx, key, result);
      return result;
    });
  }

  async export(id: number, permissions: readonly string[]) {
    await this.getBatch(id, permissions);
    const [r, m] = await Promise.all([
      this.exportPages(id, permissions, 'rows'),
      this.exportPages(id, permissions, 'matches'),
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(r.items),
      'Строки'
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(m.items),
      'Сопоставления'
    );
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }
  private async exportPages(
    id: number,
    permissions: readonly string[],
    kind: 'rows' | 'matches'
  ): Promise<{ items: Record<string, unknown>[] }> {
    const items: Record<string, unknown>[] = [];
    const pageSize = 500;
    let offset = 0;
    while (true) {
      const page = kind === 'rows'
        ? await this.rows(id, permissions, { limit: String(pageSize), offset: String(offset) })
        : await this.matches(id, permissions, { limit: String(pageSize), offset: String(offset) });
      items.push(...page.items);
      if (items.length >= page.total || page.items.length < pageSize) break;
      offset += page.items.length;
    }
    return { items };
  }
  async sources() {
    return { items: await this.onec.listSources() };
  }
  async categories(sourceId: number) {
    return { items: await this.onec.listItemCategories(sourceId) };
  }
  async nameHistory(id: number) {
    const exists = await this.db.query(`SELECT 1 FROM films WHERE film_id=$1`, [
      id,
    ]);
    if (!exists.rows.length)
      throw new ApiError(404, 'FILM_NOT_FOUND', 'Плёнка не найдена');
    const { rows } = await this.db.query(
      `SELECT h.*,ov.vendor_name old_vendor,nv.vendor_name new_vendor,u.username FROM film_name_history h LEFT JOIN vendors ov ON ov.vendor_id=h.old_vendor_id LEFT JOIN vendors nv ON nv.vendor_id=h.new_vendor_id LEFT JOIN users u ON u.user_id=h.changed_by WHERE h.film_id=$1 ORDER BY h.changed_at DESC,h.history_id DESC`,
      [id]
    );
    return {
      items: rows.map((r) => ({
        historyId: Number(r.history_id),
        oldName: r.old_name,
        newName: r.new_name,
        oldVendorName: r.old_vendor,
        newVendorName: r.new_vendor,
        changedAt: new Date(r.changed_at).toISOString(),
        changedByName: r.username,
        source: r.source,
        batchId: r.batch_id === null ? null : Number(r.batch_id),
      })),
    };
  }
  async similar(name: string, vendorId: number | null, limit: number) {
    const analysis = analyzeFilmName(name);
    const { rows } = await this.db.query(
      `WITH candidates AS (SELECT f.film_id,f.film_name,f.vendor_id,f.is_active,f.canonical_film_id,COALESCE(v.vendor_name,'') vendor_name,GREATEST(similarity(lower(f.film_name),lower($1)),COALESCE((SELECT max(similarity(lower(h.old_name),lower($1))) FROM film_name_history h WHERE h.film_id=f.film_id),0)) trigram_score,COALESCE((SELECT json_agg(h.old_name) FROM film_name_history h WHERE h.film_id=f.film_id),'[]'::json) previous_names FROM films f LEFT JOIN vendors v USING(vendor_id) WHERE ($2::smallint IS NULL OR f.vendor_id=$2)) SELECT * FROM candidates ORDER BY trigram_score DESC LIMIT 100`,
      [name, vendorId]
    );
    const ranked = rows
      .map((r) => {
        const names = [r.film_name, ...(r.previous_names as string[])];
        const nameScore = Math.max(
          ...names.map(
            (candidate) =>
              scoreCandidate(analysis, analyzeFilmName(candidate)).score
          )
        );
        return {
          filmId: Number(r.film_id),
          filmName: r.film_name,
          vendorName: r.vendor_name,
          isActive: r.is_active,
          canonicalFilmId:
            r.canonical_film_id === null ? null : Number(r.canonical_film_id),
          score: Math.max(Number(r.trigram_score), nameScore),
        };
      })
      .filter((candidate) => candidate.score >= 0.25)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return { items: ranked };
  }
  async nameIndex() {
    const result = await this.db.query(
      `WITH current_names AS (
         SELECT f.film_name AS name, f.film_id, COALESCE(f.canonical_film_id,f.film_id) AS canonical_film_id,
                f.vendor_id, f.is_active, 'current'::text AS source
         FROM films f
         WHERE (f.is_active=true AND f.canonical_film_id IS NULL)
            OR (f.is_active=false AND f.canonical_film_id IS NOT NULL)
       ), historical_names AS (
         SELECT h.old_name AS name, h.film_id, COALESCE(f.canonical_film_id,h.film_id) AS canonical_film_id,
                f.vendor_id, f.is_active, 'history'::text AS source
         FROM film_name_history h JOIN films f ON f.film_id=h.film_id
       ), name_index AS (
         SELECT * FROM current_names UNION ALL SELECT * FROM historical_names
       )
       SELECT ni.name,ni.film_id,ni.canonical_film_id,ni.vendor_id,ni.is_active,ni.source
       FROM name_index ni ORDER BY ni.name,ni.film_id,ni.source LIMIT 20001`
    );
    return {
      items: result.rows.slice(0, 20_000).map((row) => ({
        name: row.name,
        filmId: Number(row.film_id),
        canonicalFilmId: Number(row.canonical_film_id),
        vendorId: row.vendor_id === null ? null : Number(row.vendor_id),
        active: Boolean(row.is_active),
        source: row.source as 'current' | 'history',
      })),
      // Неполный индекс клиент не использует для автоматического сопоставления.
      truncated: result.rows.length > 20_000,
    };
  }

  private async resolveVendors(tx: TransactionClient, names: string[]) {
    const unique = [
      ...new Map(names.map((n) => [supplierNorm(n), n])).entries(),
    ];
    const out: Array<{
      supplier: string;
      supplierNorm: string;
      vendorId: number | null;
      vendorName: string | null;
      suggestedVendorId: number | null;
    }> = [];
    for (const [norm, supplier] of unique) {
      const alias = await tx.query(
        `SELECT a.vendor_id,v.vendor_name FROM vendor_import_aliases a JOIN vendors v USING(vendor_id) WHERE a.source_norm=$1`,
        [norm]
      );
      const dict = VENDOR_ALIASES.find(([key]) => supplierNorm(key) === norm);
      let found = alias.rows[0];
      if (!found && dict) {
        const mapped = await tx.query(
          `SELECT vendor_id,vendor_name FROM vendors WHERE lower(trim(vendor_name))=lower(trim($1)) LIMIT 1`,
          [dict[1]]
        );
        found = mapped.rows[0];
      }
      if (!found) {
        const exact = await tx.query(
          `SELECT vendor_id,vendor_name FROM vendors WHERE lower(trim(vendor_name))=$1 LIMIT 1`,
          [norm]
        );
        found = exact.rows[0];
      }
      out.push({
        supplier,
        supplierNorm: norm,
        vendorId: found ? Number(found.vendor_id) : null,
        vendorName: found?.vendor_name ?? null,
        suggestedVendorId: found ? Number(found.vendor_id) : null,
      });
    }
    return out;
  }
  private async findFileRefKey(
    tx: TransactionClient,
    nameFull: string,
    category: string | null,
    catalogKey: string
  ): Promise<{ key: string | null; warning: string | null }> {
    try {
        const refKeys = await this.onec.findRefKeysByDescription(nameFull, category);
        if (refKeys.length === 0) return { key: null, warning: null };
        if (refKeys.length !== 1)
          return { key: null, warning: 'Неоднозначное соответствие ключа 1С' };
        const key = refKeys[0]!;
      const occupied = await tx.query(
        `SELECT 1 FROM films WHERE ref_key_1c=$1 AND canonical_film_id IS NULL AND catalog_key IS DISTINCT FROM $2 LIMIT 1`,
        [key, catalogKey || catalogKeyOf(nameFull)]
      );
      return occupied.rows.length
        ? { key: null, warning: 'Ключ 1С уже связан с другой плёнкой' }
        : { key, warning: null };
    } catch {
      return { key: null, warning: null };
    }
  }
  private async loadFilms(tx: DatabaseClient): Promise<FilmCandidate[]> {
    const { rows } = await tx.query(
      `SELECT f.*,v.vendor_name,ft.film_type_name,c.catalog_key AS canonical_catalog_key,c.ref_key_1c AS canonical_ref_key_1c,(SELECT count(*)::int FROM order_details d WHERE d.film_id=f.film_id) details,(SELECT max(d.updated_at) FROM order_details d WHERE d.film_id=f.film_id) last_used_at,COALESCE((SELECT json_agg(h.old_name ORDER BY h.changed_at DESC) FROM film_name_history h WHERE h.film_id=f.film_id),'[]'::json) previous_names FROM films f LEFT JOIN vendors v USING(vendor_id) LEFT JOIN film_types ft USING(film_type_id) LEFT JOIN films c ON c.film_id=f.canonical_film_id ORDER BY f.film_id`
    );
    return rows.map((f) => ({
      filmId: Number(f.film_id),
      filmName: f.film_name,
      vendorId: f.vendor_id === null ? null : Number(f.vendor_id),
      vendorName: f.vendor_name,
      isActive: f.is_active,
      canonicalFilmId:
        f.canonical_film_id === null ? null : Number(f.canonical_film_id),
      filmTexture: f.film_texture,
      filmTypeId: Number(f.film_type_id),
      filmTypeName: String(f.film_type_name ?? ''),
      sortOrder: Number(f.sort_order),
      catalogKey: f.catalog_key,
      refKey1c: f.ref_key_1c,
      canonicalCatalogKey: f.canonical_catalog_key,
      canonicalRefKey1c: f.canonical_ref_key_1c,
      nomenclatureType: f.nomenclature_type,
      nomenclatureCategory: f.nomenclature_category,
      details: Number(f.details),
      lastUsedAt: f.last_used_at
        ? new Date(f.last_used_at).toISOString()
        : null,
      previousNames: f.previous_names,
    }));
  }
  private async loadRows(tx: DatabaseClient, id: number): Promise<ImportRow[]> {
    const { rows } = await tx.query(
      `SELECT * FROM catalog_import_rows WHERE batch_id=$1 ORDER BY row_no`,
      [id]
    );
    return rows.map((r) => ({
      rowId: Number(r.row_id),
      rowNo: Number(r.row_no),
      nameOriginal: r.name_original,
      nameFull: r.name_full,
      supplier: r.supplier,
      nomenclatureType: r.nomenclature_type,
      unit: r.unit,
      nomenclatureCategory: r.nomenclature_category,
      targetName: r.target_name,
      catalogKey: r.catalog_key,
      rowStatus: r.row_status,
      issue: r.issue,
      vendorId: r.vendor_id === null ? null : Number(r.vendor_id),
      refKey1c: r.ref_key_1c,
      canonicalFilmId:
        r.canonical_film_id === null ? null : Number(r.canonical_film_id),
      canonicalFilmTexture: r.canonical_film_texture,
      canonicalFilmTypeId:
        r.canonical_film_type_id === null
          ? null
          : Number(r.canonical_film_type_id),
      propertyConflict: null,
    }));
  }
  private async loadMatches(
    tx: DatabaseClient,
    id: number
  ): Promise<MatchResult[]> {
    const { rows } = await tx.query(
      `SELECT * FROM catalog_import_matches WHERE batch_id=$1`,
      [id]
    );
    return rows.map((r) => ({
      filmId: Number(r.film_id),
      rowId: r.row_id === null ? null : Number(r.row_id),
      matchStatus: r.match_status,
      score: r.score === null ? null : Number(r.score),
      candidates: r.candidates ?? [],
      fingerprint: r.fingerprint,
    }));
  }
  private async loadVendorMappings(tx: DatabaseClient, id: number) {
    const { rows } = await tx.query(
      `SELECT lower(trim(r.supplier)) supplier_norm,min(r.supplier) supplier,min(r.vendor_id)::int vendor_id,bool_or(r.vendor_id IS NULL) unresolved FROM catalog_import_rows r WHERE batch_id=$1 GROUP BY lower(trim(r.supplier))`,
      [id]
    );
    const { rows: batchRows } = await tx.query(
      `SELECT options FROM catalog_import_batches WHERE batch_id=$1`,
      [id]
    );
    const saved =
      (
        batchRows[0]?.options as
          | {
              vendorMappings?: Array<{
                supplierNorm: string;
                createVendor: boolean;
              }>;
            }
          | undefined
      )?.vendorMappings ?? [];
    const choices = new Map(
      saved.map((item) => [item.supplierNorm, item.createVendor])
    );
    return rows.map((r) => ({
      supplierNorm: r.supplier_norm,
      supplier: r.supplier,
      vendorId: r.vendor_id === null ? null : Number(r.vendor_id),
      createVendor: choices.get(r.supplier_norm) ?? false,
    }));
  }
  private async lockDraft(tx: TransactionClient, id: number, version: number) {
    const { rows } = await tx.query(
      `SELECT * FROM catalog_import_batches WHERE batch_id=$1 FOR UPDATE`,
      [id]
    );
    const b = rows[0];
    if (!b) throw notFound();
    if (b.status !== 'draft')
      throw new ApiError(
        409,
        'CATALOG_IMPORT_NOT_DRAFT',
        'Пакет не является черновиком'
      );
    if (Number(b.version) !== version)
      throw new ApiError(
        409,
        'CATALOG_IMPORT_STALE',
        'Версия черновика устарела'
      );
    return b;
  }
  private async claim(
    tx: TransactionClient,
    key: string,
    command: string,
    userId: number,
    shape: unknown,
    entityId = '0'
  ) {
    if (key.length < 1 || key.length > 200)
      throw validation('Idempotency-Key required (1..200)');
    const hash = createHash('sha256').update(json(shape)).digest('hex');
    const inserted = await tx.query(
      `INSERT INTO command_idempotency_keys(idempotency_key,command_name,actor_user_id,entity_type,entity_id,request_hash,status) VALUES($1,$2,$3,'catalog_import',$4,$5,'processing') ON CONFLICT DO NOTHING RETURNING idempotency_key`,
      [key, command, userId, entityId, hash]
    );
    if (inserted.rows.length) return null;
    const { rows } = await tx.query(
      `SELECT * FROM command_idempotency_keys WHERE idempotency_key=$1 FOR UPDATE`,
      [key]
    );
    const r = rows[0];
    if (
      !r ||
      r.request_hash !== hash ||
      Number(r.actor_user_id) !== userId ||
      r.command_name !== command ||
      r.entity_type !== 'catalog_import' ||
      r.entity_id !== entityId
    )
      throw new ApiError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'Idempotency-Key повторён с другим запросом'
      );
    if (r.status === 'completed' && r.response_json) return r.response_json;
    throw new ApiError(
      409,
      'IDEMPOTENCY_IN_PROGRESS',
      'Команда с таким ключом выполняется'
    );
  }
  private async complete(tx: TransactionClient, key: string, result: unknown) {
    await tx.query(
      `UPDATE command_idempotency_keys SET status='completed',response_json=$2::jsonb,completed_at=now() WHERE idempotency_key=$1`,
      [key, json(result)]
    );
  }
  private async enqueue(
    tx: TransactionClient,
    id: number,
    type: string,
    requestId: string,
    actorUserId: number,
    _revision?: number
  ) {
    // Уведомление только о результате: применение или откат (черновик/PATCH/отмена — только audit).
    if (type !== 'applied' && type !== 'reverted') return;
    const action = type;
    const key = `catalog-import:${id}:${action}`;
    const [batch, matches] = await Promise.all([
      tx.query<{ counters: unknown }>(
        `SELECT counters FROM catalog_import_batches WHERE batch_id=$1`,
        [id]
      ),
      tx.query<{ film_id: string; after: Record<string, unknown> | null }>(
        `SELECT film_id,after FROM catalog_import_matches WHERE batch_id=$1 AND after IS NOT NULL ORDER BY film_id`,
        [id]
      ),
    ]);
    const createdFilmIds: number[] = [];
    const canonicalFilmIds: number[] = [];
    const duplicateFilmIds: number[] = [];
    for (const match of matches.rows) {
      const filmId = Number(match.film_id);
      if (match.after?.created === true) createdFilmIds.push(filmId);
      else if (match.after?.canonical_film_id !== null && match.after?.canonical_film_id !== undefined) duplicateFilmIds.push(filmId);
      else canonicalFilmIds.push(filmId);
    }
    const summary = {
      matched: matches.rows.length,
      created: createdFilmIds.length,
      canonical: canonicalFilmIds.length,
      duplicates: duplicateFilmIds.length,
    };
    await tx.query(
      `INSERT INTO outbox_events(event_type,aggregate_type,aggregate_id,payload_json,idempotency_key) VALUES('films.catalog_import_changed','catalog_import_batch',$1,$2::jsonb,$3) ON CONFLICT(idempotency_key) DO NOTHING`,
      [
        String(id),
        json({
          eventId: randomUUID(),
          eventType: 'films.catalog_import_changed',
          action,
          actorUserId,
          requestId,
          correlationId: requestId,
          source: 'erp_ui',
          occurredAt: new Date().toISOString(),
          entity: { type: 'catalog_import_batch', id },
          counters: batch.rows[0]?.counters ?? {},
          summary,
          filmIds: {
            canonical: canonicalFilmIds,
            duplicates: duplicateFilmIds,
            created: createdFilmIds,
          },
        }),
        key,
      ]
    );
  }
  private async setChangeSettings(
    tx: TransactionClient,
    userId: number,
    id: number,
    source: string
  ) {
    await tx.query(
      `SELECT set_config('erp.film_catalog','on',true),set_config('erp.film_change_source',$1,true),set_config('erp.film_change_batch',$2,true),set_config('erp.film_change_actor',$3,true)`,
      [source, String(id), String(userId)]
    );
    await tx.query(`SELECT set_session_user($1)`, [userId]);
    await tx.query(`SELECT set_config('app.user_id',$1,true)`, [
      String(userId),
    ]);
  }
  private async assertNoStock(
    tx: TransactionClient,
    filmIds: number[],
    conflicts: Array<{ filmId?: number; rowId?: number; reason: string }>
  ) {
    const ids = [...new Set(filmIds)];
    const available = await tx.query<{ table_name: string }>(
      `SELECT table_name FROM unnest(ARRAY['stock_balances','stock_movements','stock_document_lines']::text[]) table_name WHERE to_regclass('public.'||table_name) IS NOT NULL`
    );
    for (const { table_name } of available.rows) {
      // Строки отменённых документов (отменяется только черновик — движений нет) не держат плёнку:
      // слияние/откат не меняют остатков; черновики и проведённые документы по-прежнему блокируют.
      const exists = await tx.query(
        table_name === 'stock_document_lines'
          ? `SELECT 1 FROM stock_document_lines l JOIN stock_documents d USING(document_id) WHERE l.film_id=ANY($1::bigint[]) AND d.status<>'cancelled' LIMIT 1`
          : `SELECT 1 FROM ${table_name} WHERE film_id=ANY($1::bigint[]) LIMIT 1`,
        [ids]
      );
      if (exists.rows.length) {
        for (const filmId of ids)
          conflicts.push({ filmId, reason: `stock_dependency:${table_name}` });
        return;
      }
    }
  }
  private filmRecord(f: Record<string, unknown>) {
    return normalizeFilmBusinessFields({
      film_name: f.film_name,
      vendor_id: f.vendor_id,
      film_type_id: f.film_type_id,
      film_texture: f.film_texture,
      is_active: f.is_active,
      sort_order: f.sort_order,
      canonical_film_id: f.canonical_film_id,
      catalog_key: f.catalog_key,
      ref_key_1c: f.ref_key_1c,
      nomenclature_type: f.nomenclature_type,
      nomenclature_category: f.nomenclature_category,
    });
  }
  private counts(
    rows: ImportRow[],
    matches: MatchResult[],
    _vendors: unknown[]
  ) {
    const rowsOk = rows.filter((r) => r.rowStatus === 'ok').length,
      rowsInvalid = rows.filter((r) => r.rowStatus === 'invalid').length,
      rowsSkipped = rows.filter((r) => r.rowStatus === 'skipped').length;
    const count = (s: string) =>
      matches.filter((m) => m.matchStatus === s).length;
    const mapped = matches.filter(
      (m) =>
        m.rowId !== null &&
        ['linked', 'auto', 'confirmed', 'manual'].includes(m.matchStatus)
    );
    const groups = new Set(mapped.map((m) => m.rowId));
    const noMatch = rows.filter(
      (r) => r.rowStatus === 'ok' && !groups.has(r.rowId)
    ).length;
    const unresolvedGroups = rows.filter(
      (r) => r.propertyConflict !== null && r.canonicalFilmTexture === null
    ).length;
    return {
      rows: rows.length,
      rowsOk,
      rowsInvalid,
      rowsSkipped,
      films: matches.length,
      linked: count('linked'),
      auto: count('auto'),
      suggested: count('suggested'),
      confirmed: count('confirmed'),
      manual: count('manual'),
      none: count('none'),
      unchanged: count('unchanged'),
      toRename: mapped.length,
      toMerge: Math.max(0, mapped.length - groups.size),
      toCreate: noMatch,
      unresolvedGroups,
    };
  }
  private countsFrom(
    saved: Record<string, number>,
    rows: Array<Record<string, unknown>>,
    matches: Array<Record<string, unknown>>
  ) {
    const mapped = this.counts([], [], []);
    const rowCount = (key: string) =>
      Number(rows.find((x) => x.row_status === key)?.n ?? 0);
    const matchCount = (key: string) =>
      Number(matches.find((x) => x.match_status === key)?.n ?? 0);
    return {
      ...mapped,
      ...saved,
      rows: Number(saved?.rows ?? 0),
      rowsOk: rowCount('ok'),
      rowsInvalid: rowCount('invalid'),
      rowsSkipped: rowCount('skipped'),
      films: matches.reduce((n, x) => n + Number(x.n), 0),
      linked: matchCount('linked'),
      auto: matchCount('auto'),
      suggested: matchCount('suggested'),
      confirmed: matchCount('confirmed'),
      manual: matchCount('manual'),
      none: matchCount('none'),
      unchanged: matchCount('unchanged'),
    };
  }
}
function validation(message: string) {
  return new ApiError(400, 'VALIDATION_FAILED', message);
}
function parsePagination(query: Record<string, string | undefined>) {
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw validation('limit must be between 1 and 500');
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw validation('offset must be a nonnegative integer');
  return { limit, offset };
}
function parsePositiveQuery(value: string, field: string): number {
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw validation(`${field} must be a positive integer`);
  return Number(value);
}
function notFound() {
  return new ApiError(
    404,
    'CATALOG_IMPORT_NOT_FOUND',
    'Пакет импорта не найден'
  );
}
