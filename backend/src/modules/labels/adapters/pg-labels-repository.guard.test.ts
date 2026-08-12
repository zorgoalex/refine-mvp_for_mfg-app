import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';

vi.mock('sharp', () => ({ default: vi.fn() }));

const { buildOrderLabelsArchiveFilename, PgLabelsRepository } = await import('./pg-labels-repository');

const source = readFileSync(new URL('./pg-labels-repository.ts', import.meta.url), 'utf8');
const cutMapMigration = readFileSync(
  new URL('../../../../db/migrations/081_label_cut_maps.sql', import.meta.url),
  'utf8',
);

describe('PgLabelsRepository structural guards', () => {
  it('requires row version when updating existing order label data', () => {
    expect(source).toMatch(/beforeVersion != null && row\.version == null/);
    expect(source).toMatch(/OrderLabelDataStaleVersionError\(row\.detailId,\s*null,\s*beforeVersion\)/);
  });

  it('uses command idempotency for non-generation label writes', () => {
    expect(source).toMatch(/label_template\.create/);
    expect(source).toMatch(/label_template\.update/);
    expect(source).toMatch(/label_template\.delete/);
    expect(source).toMatch(/order_label_data\.update/);
  });

  it('deactivates templates without tombstoning rows needed by saved label data', () => {
    expect(source).toMatch(/SET is_active=false, version=version\+1/);
    expect(source).not.toMatch(/deleted_at=COALESCE\(deleted_at, now\(\)\)/);
  });

  it('persists the template active flag on create and preserves it on legacy updates', () => {
    const createSource = source.slice(source.indexOf('async createTemplate'), source.indexOf('async updateTemplate'));
    const updateSource = source.slice(source.indexOf('async updateTemplate'), source.indexOf('async deleteTemplate'));

    expect(createSource).toMatch(/\(name, description, is_active, canvas_width_mm/);
    expect(createSource).toMatch(/input\.isActive \?\? true/);
    expect(updateSource).toMatch(/name=\$2, description=\$3, is_active=\$4/);
    expect(updateSource).toMatch(/input\.isActive \?\? before\.isActive/);
  });

  it('discovers detail fields from the live order details view schema', () => {
    expect(source).toMatch(/information_schema\.columns/);
    expect(source).toMatch(/table_name = 'order_details_view'/);
    expect(source).toMatch(/ORDER BY ordinal_position/);
  });

  it('enriches label detail fields with current regular and vacuum cut result version numbers', () => {
    expect(source).toContain('DETAIL_CUT_RESULT_VERSION_REGULAR_FIELD');
    expect(source).toContain('DETAIL_CUT_RESULT_VERSION_VACUUM_FIELD');
    expect(source.match(/DETAIL_FIELDS_JSON_SQL/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source.match(/DETAIL_CUT_RESULT_VERSION_FIELDS_SQL/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(source).toContain("cpp.params->>'layout_mode'");
    expect(source).toContain("= 'vacuum_table' AS is_vacuum");
    expect(source).toContain('PARTITION BY (is_vacuum IS TRUE)');
    expect(source).toContain("COALESCE(NULLIF(btrim(cj.source_display_number), ''), cj.cut_job_id::text) AS cut_job_display_number");
    expect(source).toContain("max(cut_job_display_number || '-' || result_no::text) FILTER (WHERE is_vacuum IS NOT TRUE AND rn = 1) AS regular_cut_number");
    expect(source).toContain("max('В-' || cut_job_display_number || '-' || result_no::text) FILTER (WHERE is_vacuum IS TRUE AND rn = 1) AS vacuum_cut_number");
    expect(source).toContain('FILTER (WHERE is_vacuum IS NOT TRUE AND rn = 1) AS regular_cut_number');
    expect(source).toContain('FILTER (WHERE is_vacuum IS TRUE AND rn = 1) AS vacuum_cut_number');
  });

  it('exposes cut-map vacuum profile metadata for non-vacuum default selection', () => {
    expect(source).toContain('cpp.params->>\'layout_mode\'');
    expect(source).toContain('AS is_vacuum');
    expect(source).toContain('isVacuum: row.is_vacuum === true');
  });

  it('projects label cut-map thumbnails from the immutable top-left render view', () => {
    expect(cutMapMigration).toContain("r0:raw:top-left:labels-off");
    expect(source).toContain('s.base_svg');
  });

  it('hydrates existing generated-label cut maps with their frozen vacuum classification', () => {
    const loaderStart = source.indexOf('async function loadCutMapAssets');
    const loaderEnd = source.indexOf('interface PreviewTokenPayload', loaderStart);
    const loader = source.slice(loaderStart, loaderEnd);

    expect(source).toContain("group_json #>> '{summary,engine_used}'");
    expect(source).toContain("= 'vacuum_table'");
    expect(loader).toContain('${CUT_RESULT_SHEET_IS_VACUUM_SQL} AS is_vacuum');
    expect(loader).toContain('isVacuum: row.is_vacuum === true');
  });

  it('ranks Telegram screenshot candidates by recency before checking evidence ambiguity', () => {
    const imageResolverStart = source.indexOf('const imageResult = await client.query<TelegramImageCandidateRow>');
    const imageResolverEnd = source.indexOf('const imageByCopy', imageResolverStart);
    const imageResolver = source.slice(imageResolverStart, imageResolverEnd);

    expect(imageResolver).toContain('COALESCE(packet.completed_at, packet.source_updated_at, packet.source_created_at, packet.updated_at) DESC');
    expect(imageResolver).not.toContain('evidence.evidence_eligible DESC');
    expect(imageResolver).toContain('PARTITION BY evidence.order_id, evidence.detail_id');
    expect(imageResolver).toContain('candidate.candidate_rank=1');
    expect(imageResolver).not.toContain('requested.instance <= LEAST');
  });

  it('ranks newest Telegram SVG per detail before expanding its placements to requested copies', () => {
    const svgStart = source.indexOf('const svgResult = await client.query<TelegramSvgCandidateRow>');
    const svgEnd = source.indexOf('const svgByCopy', svgStart);
    const svgResolver = source.slice(svgStart, svgEnd);

    expect(svgResolver).toContain('PARTITION BY candidate.order_id, candidate.order_detail_id');
    expect(svgResolver).not.toContain('PARTITION BY requested.order_id, requested.detail_id, requested.instance');
    expect(svgResolver.indexOf('candidate.candidate_rank=1'))
      .toBeLessThan(svgResolver.indexOf('placement.instance=requested.instance'));
    expect(svgResolver.indexOf('candidate.candidate_rank=1'))
      .toBeLessThan(svgResolver.indexOf('requested.instance <= detail.quantity'));
    expect(svgResolver.indexOf('candidate.candidate_rank=1'))
      .toBeLessThan(svgResolver.indexOf('abs(placement.source_width_mm-detail.width)'));
  });

  it('ranks newest Telegram image packet before mutable detail validation', () => {
    const imageStart = source.indexOf('const imageResult = await client.query<TelegramImageCandidateRow>');
    const imageEnd = source.indexOf('const imageByCopy', imageStart);
    const imageResolver = source.slice(imageStart, imageEnd);

    expect(imageResolver.indexOf('candidate.candidate_rank=1'))
      .toBeLessThan(imageResolver.indexOf('abs(candidate.width_mm-detail.width)'));
  });

  it('validates screenshot options without full PNG preparation', () => {
    const optionsStart = source.indexOf('async function addTelegramFallbackOptions');
    const optionsEnd = source.indexOf('function cutMapSourceMatches', optionsStart);
    const optionsResolver = source.slice(optionsStart, optionsEnd);

    expect(optionsResolver).toContain("imageMode: 'validate'");
    expect(source).toContain("telegram.imageMode === 'validate'");
    expect(source).toContain('validateTelegramImage(telegram.mediaDir, metadata)');
    expect(source).toContain('attemptedStorageKeys.size >= 16');
  });

  it('exposes detail cut and bath calculation numbers for source selection in order labels', () => {
    expect(source).toContain('cutJobCutNumber: row.regular_cut_number');
    expect(source).toContain('bathCutJobCutNumber: row.vacuum_cut_number');
    expect(source).toContain('cut_version_fields.regular_cut_number, cut_version_fields.vacuum_cut_number');
  });

  it('filters required label cut-map selections by selected source', () => {
    expect(source).toContain("$4::text = 'bath'");
    expect(source).toContain("$4::text = 'regular'");
    expect(source).toContain("'В-' || COALESCE(NULLIF(btrim(j.source_display_number), ''), p.cut_job_id::text) || '-' || r.result_no::text) = cut_version_fields.vacuum_cut_number");
    expect(source).toContain("= cut_version_fields.regular_cut_number");
    expect(source).toContain('LABEL_CUT_MAP_SELECTION_SOURCE_MISMATCH');
    expect(source).toContain('cutMapSourceMatches');
    expect(source).toContain('cutMapPlacementMatchesSource');
    expect(source).toContain('expectedCutNumber');
  });

  it('persists field catalog snapshots for label and QR templates', () => {
    expect(source).toMatch(/field_catalog_snapshot/);
    expect(source).toMatch(/JSON\.stringify\(command\.fieldCatalogSnapshot \?\? \{\}\)/);
  });

  it('matches cut-map options against immutable snapshot dimensions', () => {
    expect(source.match(/jsonb_array_elements\(r\.snapshot_job -> 'items'\)/g)).toHaveLength(3);
    expect(source).toMatch(/snapshot_item\.item_json #>> '\{detail,width\}'/);
    expect(source).toMatch(/snapshot_item\.item_json #>> '\{detail,height\}'/);
    expect(source).not.toMatch(/abs\(maps\.detail_width_mm - od\.width\)/);
    expect(source).not.toMatch(/abs\(maps\.detail_height_mm - od\.height\)/);
    expect(source).not.toMatch(/abs\(p\.detail_width_mm - od\.width\)/);
    expect(source).not.toMatch(/abs\(p\.detail_height_mm - od\.height\)/);
  });

  it('excludes archived cut result placements from selectable label cut maps', () => {
    expect(source).toContain('LEFT JOIN cut_result_archive_state archive');
    expect(source).toContain("j.status <> 'archived' AND archive.archived_at IS NULL");
    expect(source).toContain('WHERE archive.archived_at IS NULL');
    expect(source).toContain('AND archive.archived_at IS NULL');
  });

  it('orders label cut-map options by acting public result number, not only cut_result_id', () => {
    expect(source).toContain('LEFT JOIN cut_result current_result');
    expect(source).toContain('current_result.result_no = r.result_no');
    expect(source).not.toContain('j.current_cut_result_id = r.cut_result_id');
  });

  it('renders every order label SVG page for preview and latest, not only the first row', () => {
    const previewStart = source.indexOf('async previewOrderLabels');
    const previewEnd = source.indexOf('async generateOrderLabels', previewStart);
    const previewSource = source.slice(previewStart, previewEnd);
    expect(previewSource).toMatch(/renderSvgPages\(template,\s*rows,\s*resolved\.assets\)/);
    expect(previewSource).not.toMatch(/rows\.slice\(0,\s*1\)/);

    const latestStart = source.indexOf('async getLatestOrderLabelsPreview');
    const latestEnd = source.indexOf('async recordPermissionDenied', latestStart);
    const latestSource = source.slice(latestStart, latestEnd);
    expect(latestSource).toMatch(/renderSvgPages\(\s*generation\.template,\s*generation\.rows,/);
    expect(latestSource).not.toMatch(/generation\.rows\.slice\(0,\s*1\)/);
    expect(latestSource).toMatch(/rows:\s*generation\.rows/);
  });

  it('renders every detail label SVG page for preview, not only the first row', () => {
    const previewStart = source.indexOf('async previewDetailLabels');
    const previewEnd = source.indexOf('async generateDetailLabels', previewStart);
    const previewSource = source.slice(previewStart, previewEnd);
    expect(previewSource).toContain('resolveDetailLabelCutMaps');
    expect(previewSource).toMatch(/renderSvgPages\(template,\s*rows,\s*resolved\.assets\)/);
    expect(previewSource).not.toMatch(/rows\.slice\(0,\s*1\)/);
    expect(source).not.toContain('assertCutMapOrderScope');
    expect(source).not.toContain('LABEL_CUT_MAP_ORDER_SCOPE_ONLY');
  });

  it('binds explicit sheet screenshot cut-map fallback to matching Telegram evidence rows', () => {
    const helperStart = source.indexOf('async function assertExplicitTelegramImageRowsBelongToPacket');
    expect(helperStart).toBeGreaterThan(-1);
    const helperSource = source.slice(helperStart, source.indexOf('async function prepareExplicitTelegramSheetImage', helperStart));
    expect(helperSource).toContain('cnc_telegram_packet_item_evidence');
    expect(helperSource).toContain('evidence.match_order_id');
    expect(helperSource).toContain('evidence.match_detail_id');
    expect(helperSource).toContain('requested.instance <= evidence.evidence_quantity');
    expect(helperSource).toContain('dimensions_match');
    expect(helperSource).toContain('LABEL_CUT_MAP_FALLBACK_MISMATCH');
  });

  it('allows Telegram screenshot fallback when only text layout exists and no SVG result is imported', () => {
    const helperStart = source.indexOf('async function assertExplicitTelegramImageRowsBelongToPacket');
    const helperSource = source.slice(helperStart, source.indexOf('async function prepareExplicitTelegramSheetImage', helperStart));
    const imageStart = source.indexOf('const imageResult = await client.query<TelegramImageCandidateRow>');
    const imageResolver = source.slice(imageStart, source.indexOf('const imageByCopy', imageStart));

    for (const resolver of [helperSource, imageResolver]) {
      expect(resolver).toContain("packet.svg_cut_import_status IS DISTINCT FROM 'imported'");
      expect(resolver).toContain('packet.svg_cut_job_id IS NULL');
      expect(resolver).toContain('packet.svg_cut_result_id IS NULL');
      expect(resolver).not.toContain("packet.cut_layout_json->>'status'='valid'");
    }
    expect(imageResolver).toContain("packet.cut_layout_json #>> '{sheet,widthMm}' AS sheet_width_mm");
    expect(imageResolver).toContain("packet.cut_layout_json #>> '{sheet,heightMm}' AS sheet_height_mm");
  });

  it('names order archives from the order name and current generation number', () => {
    expect(buildOrderLabelsArchiveFilename(' Кухня / Север ', 22)).toBe('заказ-Кухня - Север-бирки-22.zip');
    expect(buildOrderLabelsArchiveFilename(null, 4)).toBe('заказ-без-названия-бирки-4.zip');
    expect(buildOrderLabelsArchiveFilename(`${'a'.repeat(119)}😀`, 5)).toBe(`заказ-${'a'.repeat(119)}😀-бирки-5.zip`);
  });

  it('rejects an invalid stored versioned template before generation side effects', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ idempotency_key: 'generation-invalid-stored' }] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          label_template_id: 9,
          name: 'Broken',
          description: null,
          version: 1,
          is_active: true,
          canvas_width_mm: 85,
          canvas_height_mm: 88,
          dpi: 203,
          default_export_formats: ['png'],
          custom_field_schema: {},
          field_catalog_snapshot: {},
        }],
      })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          label_template_element_id: 1,
          element_key: 'bad',
          kind: 'text',
          source_field: null,
          static_text: 'Bad',
          x_mm: 0,
          y_mm: 0,
          width_mm: 20,
          height_mm: 5,
          rotation_deg: 0,
          z_index: 0,
          style_json: { typography: { version: 1, fontSizePt: '12', fontWeight: 'normal', italic: false } },
          condition_json: {},
        }],
      });
    const tx = { query };
    const database = {
      transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as DatabaseService;
    const repo = new PgLabelsRepository(database);

    await expect(repo.generateOrderLabels({
      currentUser: { id: '1', username: 'tester', role: 'manager', roleId: 1, permissions: ['labels.generate'] },
      requestId: 'req-invalid-stored',
      orderId: 42,
      input: {
        templateId: 9,
        templateVersion: 1,
        previewToken: previewToken({ orderId: 42, templateId: 9, templateVersion: 1 }),
        exportFormats: ['png'],
        idempotencyKey: 'generation-invalid-stored',
      },
    })).rejects.toMatchObject({ statusCode: 422, code: 'LABEL_ELEMENT_SCHEMA_INVALID' });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO order_label_generations|outbox_events/i.test(String(sql))))
      .toBe(false);
  });

  it('fails closed when listTemplates encounters a malformed stored custom formula', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          label_template_id: 9,
          name: 'Broken formula',
          description: null,
          version: 1,
          is_active: true,
          canvas_width_mm: 85,
          canvas_height_mm: 88,
          dpi: 203,
          default_export_formats: ['png'],
          custom_field_schema: {
            'custom.bad': {
              type: 'string',
              expression: { type: 'custom_expression', version: 99, root: { type: 'empty' } },
            },
          },
          field_catalog_snapshot: {},
        }],
      })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const database = { query } as unknown as DatabaseService;
    const repo = new PgLabelsRepository(database);

    await expect(repo.listTemplates({
      currentUser: { id: '1', username: 'tester', role: 'manager', roleId: 1, permissions: ['labels.view'] },
      requestId: 'req-list-invalid-expression',
      includeInactive: true,
    })).rejects.toMatchObject({ statusCode: 422, code: 'LABEL_CUSTOM_EXPRESSION_INVALID' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('replays a completed generation before revalidating mutable order state', async () => {
    const response = {
      generationId: 77,
      orderId: 42,
      templateId: 9,
      templateVersion: 1,
      labelCount: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
    };
    let requestHash = '';
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO command_idempotency_keys')) {
        requestHash = String(params?.[5] ?? '');
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('FROM command_idempotency_keys')) {
        return { rowCount: 1, rows: [{ request_hash: requestHash, response_json: response, status: 'completed' }] };
      }
      throw new Error(`unexpected live-state query: ${sql}`);
    });
    const tx = { query };
    const database = {
      transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    } as unknown as DatabaseService;
    const repo = new PgLabelsRepository(database);

    await expect(repo.generateOrderLabels({
      currentUser: { id: '1', username: 'tester', role: 'manager', roleId: 1, permissions: ['labels.generate'] },
      requestId: 'req-replay',
      orderId: 42,
      input: {
        templateId: 9,
        templateVersion: 1,
        previewToken: previewToken({ orderId: 42, templateId: 9, templateVersion: 1 }),
        exportFormats: ['png'],
        idempotencyKey: 'generation-replay-completed',
      },
    })).resolves.toEqual(response);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('replays a completed Telegram generation before reading mutable media or order state', async () => {
    const response = {
      generationId: 78,
      orderId: 42,
      templateId: 9,
      templateVersion: 1,
      labelCount: 1,
      generatedAt: '2026-07-21T00:00:00.000Z',
    };
    const token = previewToken({
      orderId: 42,
      templateId: 9,
      templateVersion: 1,
      cutMapSource: 'regular',
      telegramCutMapFallbackVersion: 'v1',
    });
    const requestHash = createHash('sha256').update(JSON.stringify({
      orderId: 42,
      templateId: 9,
      templateVersion: 1,
      detailIds: [],
      useBasisFields: true,
      cutMapSource: 'regular',
      telegramCutMapFallbackVersion: 'v1',
      rowHash: 'frozen-preview-row-hash',
      exportFormats: ['png'],
    })).digest('hex');
    const query = vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ request_hash: requestHash, response_json: response, status: 'completed' }],
    });
    const transaction = vi.fn(async () => {
      throw new Error('transaction must not start for completed replay');
    });
    const database = { query, transaction } as unknown as DatabaseService;
    const repo = new PgLabelsRepository(database, {
      telegramFallbackEnabled: true,
      telegramMediaDir: '/missing-media-must-not-be-read',
    });

    await expect(repo.generateOrderLabels({
      currentUser: { id: '1', username: 'tester', role: 'manager', roleId: 1, permissions: ['labels.generate'] },
      requestId: 'req-telegram-replay',
      orderId: 42,
      input: {
        templateId: 9,
        templateVersion: 1,
        previewToken: token,
        exportFormats: ['png'],
        cutMapSource: 'regular',
        telegramCutMapFallbackVersion: 'v1',
        idempotencyKey: 'generation-telegram-replay-completed',
      },
    })).resolves.toEqual(response);
    expect(query).toHaveBeenCalledTimes(1);
    expect(transaction).not.toHaveBeenCalled();
  });
});

function previewToken(input: {
  orderId: number;
  templateId: number;
  templateVersion: number;
  cutMapSource?: 'regular' | 'bath';
  telegramCutMapFallbackVersion?: 'v1';
}): string {
  return Buffer.from(JSON.stringify({
    ...input,
    detailIds: [],
    useBasisFields: true,
    rowHash: 'frozen-preview-row-hash',
  })).toString('base64url');
}
