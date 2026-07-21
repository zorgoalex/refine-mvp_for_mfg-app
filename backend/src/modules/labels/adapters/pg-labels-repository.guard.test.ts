import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { buildOrderLabelsArchiveFilename, PgLabelsRepository } from './pg-labels-repository';

const source = readFileSync(new URL('./pg-labels-repository.ts', import.meta.url), 'utf8');

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

  it('discovers detail fields from the live order details view schema', () => {
    expect(source).toMatch(/information_schema\.columns/);
    expect(source).toMatch(/table_name = 'order_details_view'/);
    expect(source).toMatch(/ORDER BY ordinal_position/);
  });

  it('persists field catalog snapshots for label and QR templates', () => {
    expect(source).toMatch(/field_catalog_snapshot/);
    expect(source).toMatch(/JSON\.stringify\(command\.fieldCatalogSnapshot \?\? \{\}\)/);
  });

  it('matches cut-map options against immutable snapshot dimensions', () => {
    expect(source.match(/jsonb_array_elements\(r\.snapshot_job -> 'items'\)/g)).toHaveLength(2);
    expect(source).toMatch(/snapshot_item\.item_json #>> '\{detail,width\}'/);
    expect(source).toMatch(/snapshot_item\.item_json #>> '\{detail,height\}'/);
    expect(source).not.toMatch(/abs\(maps\.detail_width_mm - od\.width\)/);
    expect(source).not.toMatch(/abs\(maps\.detail_height_mm - od\.height\)/);
    expect(source).not.toMatch(/abs\(p\.detail_width_mm - od\.width\)/);
    expect(source).not.toMatch(/abs\(p\.detail_height_mm - od\.height\)/);
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
});

function previewToken(input: { orderId: number; templateId: number; templateVersion: number }): string {
  return Buffer.from(JSON.stringify({
    ...input,
    detailIds: [],
    useBasisFields: true,
    rowHash: 'frozen-preview-row-hash',
  })).toString('base64url');
}
