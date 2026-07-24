import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../../../database/database.types';
import { renderSvgPages } from '../application/label-renderer';
import type { LabelRow } from '../application/label-row-builder';
import type { LabelTemplateDto } from '../application/labels.types';
import { resolveLabelCutMaps } from './pg-labels-repository';

describe('label cut-map resolution', () => {
  it('binds an exact physical placement and frozen sheet asset to the row', async () => {
    const client = databaseReturning(placementRow());
    const resolved = await resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
    );

    expect(resolved.rows[0].cutMap).toMatchObject({
      cutResultPlacementId: 700,
      cutNumber: '30-4',
      sheetNumber: 2,
      xMm: 110,
      yMm: 70,
    });
    expect(resolved.rows[0].values).toMatchObject({ 'cut.number': '30-4', 'cut.sheet_number': 2 });
    expect(resolved.assets.get(600)).toContain('<svg');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_array_elements(r.snapshot_job -> 'items')"),
      [[700], 20],
    );
  });

  it('fails closed when a placement belongs to another physical instance', async () => {
    const client = databaseReturning(placementRow({ instance: 2 }));
    await expect(resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
    )).rejects.toMatchObject({ code: 'LABEL_CUT_MAP_SELECTION_MISMATCH' });
  });

  it('keeps a label without a cut-map when the physical detail was not cut', async () => {
    const client = databaseReturning();
    const resolved = await resolveLabelCutMaps(client, template(), [labelRow()], [], 20);

    expect(resolved.rows[0].cutMap).toBeUndefined();
    expect(renderSvgPages(template(), resolved.rows, resolved.assets).pages[0])
      .not.toContain('data-label-element-kind="cut_map"');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('JOIN unnest($1::bigint[], $2::bigint[], $3::integer[])'),
      [[20], [10], [1]],
    );
  });

  it('requires a selection when the physical detail has a valid cut placement', async () => {
    const client = databaseReturning(placementRow());

    await expect(resolveLabelCutMaps(client, template(), [labelRow()], [], 20))
      .rejects.toMatchObject({ code: 'LABEL_CUT_MAP_SELECTION_REQUIRED' });
  });

  it('rejects an omitted placement when the detail changed after cutting', async () => {
    const client = databaseReturning(placementRow({ dimensions_match: false }));

    await expect(resolveLabelCutMaps(client, template(), [labelRow()], [], 20))
      .rejects.toMatchObject({ code: 'LABEL_CUT_MAP_DETAIL_CHANGED' });
  });

  it('resolves selected cut rows while keeping uncut order rows in the same generation', async () => {
    const client = databaseReturningSequence([], [placementRow()]);
    const resolved = await resolveLabelCutMaps(
      client,
      template(),
      [labelRow(), labelRow({ rowIndex: 2, detailId: 11 })],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
    );

    expect(resolved.rows[0].cutMap?.cutResultPlacementId).toBe(700);
    expect(resolved.rows[1].cutMap).toBeUndefined();
    const pages = renderSvgPages(template(), resolved.rows, resolved.assets).pages;
    expect(pages[0]).toContain('data-label-element-kind="cut_map"');
    expect(pages[1]).not.toContain('data-label-element-kind="cut_map"');
  });

  it('rotates a landscape cut sheet to match a portrait template placeholder', async () => {
    const client = databaseReturning(placementRow());
    const portraitTemplate = template();
    portraitTemplate.elements[0] = {
      ...portraitTemplate.elements[0],
      widthMm: 18,
      heightMm: 42,
    };
    const resolved = await resolveLabelCutMaps(
      client,
      portraitTemplate,
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
    );

    const svg = renderSvgPages(portraitTemplate, resolved.rows, resolved.assets).pages[0];
    expect(svg).toContain('width="18" height="42" viewBox="0 0 2070 2800"');
    expect(svg).toContain('transform="translate(2070 0) rotate(90)"');
  });
});

function databaseReturning(row?: ReturnType<typeof placementRow>): DatabaseClient & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  } as unknown as DatabaseClient & { query: ReturnType<typeof vi.fn> };
}

function databaseReturningSequence(...rows: Array<Array<ReturnType<typeof placementRow>>>): DatabaseClient & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  for (const resultRows of rows) {
    query.mockResolvedValueOnce({ rows: resultRows, rowCount: resultRows.length });
  }
  return { query } as unknown as DatabaseClient & { query: ReturnType<typeof vi.fn> };
}

function labelRow(overrides: Partial<LabelRow> = {}): LabelRow {
  return {
    rowIndex: 1,
    detailId: 10,
    orderId: 20,
    copyIndex: 1,
    copyCount: 1,
    values: {},
    ...overrides,
  };
}

function template(): LabelTemplateDto {
  return {
    labelTemplateId: 1,
    name: 'С картой',
    description: null,
    version: 1,
    isActive: true,
    canvasWidthMm: 85,
    canvasHeightMm: 55,
    dpi: 203,
    defaultExportFormats: ['png'],
    customFieldSchema: {},
    fieldCatalogSnapshot: {},
    rendererCapabilities: ['cut_map_v1'],
    elements: [{
      labelTemplateElementId: 1,
      elementKey: 'cut-map',
      kind: 'cut_map',
      sourceField: null,
      staticText: null,
      xMm: 1,
      yMm: 1,
      widthMm: 40,
      heightMm: 20,
      rotationDeg: 0,
      zIndex: 0,
      style: { cutMap: { version: 1, fit: 'contain', highlightFill: '#ffd666', highlightStroke: '#d4380d' } },
      condition: {},
    }],
  };
}

function placementRow(overrides: Record<string, unknown> = {}) {
  return {
    cut_result_placement_id: 700,
    cut_result_sheet_map_id: 600,
    cut_result_id: 500,
    cut_job_id: 30,
    order_id: 20,
    order_detail_id: 10,
    instance: 1,
    variant: 'auto' as const,
    sheet_index: 9,
    sheet_ordinal: 2,
    sheet_width_mm: 2800,
    sheet_height_mm: 2070,
    x_mm: 110,
    y_mm: 70,
    width_mm: 500,
    height_mm: 300,
    result_no: 4,
    cut_job_name: 'Кухня',
    base_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2800 2070"></svg>',
    dimensions_match: true,
    ...overrides,
  };
}
