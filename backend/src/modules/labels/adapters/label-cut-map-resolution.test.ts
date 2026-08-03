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
    expect(resolved.assets.get(600)).toEqual({
      svg: expect.stringContaining('<svg'),
      isVacuum: false,
    });
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
      [[20], [10], [1], null],
    );
  });

  it('limits omitted placement requirements to the selected cut-map source', async () => {
    const client = databaseReturning();
    const resolved = await resolveLabelCutMaps(client, template(), [labelRow()], [], 20, 'regular');

    expect(resolved.rows[0].cutMap).toBeUndefined();
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("$4::text = 'regular'"),
      [[20], [10], [1], 'regular'],
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

  it('rejects a selected placement from another cut-map source', async () => {
    const client = databaseReturning(placementRow({ is_vacuum: true }));

    await expect(resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
      'regular',
    )).rejects.toMatchObject({ code: 'LABEL_CUT_MAP_SELECTION_SOURCE_MISMATCH' });
  });

  it('rejects a selected placement when it does not match the detail source cut number', async () => {
    const client = databaseReturning(placementRow({ regular_cut_number: '31-4' }));

    await expect(resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
      'regular',
    )).rejects.toMatchObject({
      code: 'LABEL_CUT_MAP_SELECTION_SOURCE_MISMATCH',
      details: expect.objectContaining({ cutNumber: '30-4', expectedCutNumber: '31-4' }),
    });
  });

  it('keeps a portrait non-vacuum sheet top-left when fitting a landscape label box', async () => {
    const client = databaseReturning(placementRow({
      sheet_width_mm: 2070,
      sheet_height_mm: 2800,
      base_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2070 2800"></svg>',
    }));
    const resolved = await resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
    );

    const svg = renderSvgPages(template(), resolved.rows, resolved.assets).pages[0];
    expect(svg).toContain('width="40" height="20" viewBox="0 0 2800 2070"');
    expect(svg).toContain('transform="matrix(0 1 1 0 0 0)"');
    expect(svg).not.toContain('transform="translate(2800 0) rotate(90)"');
  });

  it('keeps a landscape non-vacuum sheet top-left when fitting a portrait label box', async () => {
    const client = databaseReturning(placementRow({
      sheet_width_mm: 1000,
      sheet_height_mm: 500,
      base_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"></svg>',
    }));
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
    expect(svg).toContain('width="18" height="42" viewBox="0 0 500 1000"');
    expect(svg).toContain('transform="matrix(0 1 1 0 0 0)"');
    expect(svg).not.toContain('transform="translate(500 0) rotate(90)"');
  });

  it('preserves the legacy rotated orientation for vacuum cut sheets', async () => {
    const client = databaseReturning(placementRow({
      sheet_width_mm: 2070,
      sheet_height_mm: 2800,
      base_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2070 2800"></svg>',
      is_vacuum: true,
    }));
    const resolved = await resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
    );

    const svg = renderSvgPages(template(), resolved.rows, resolved.assets).pages[0];
    expect(svg).toContain('transform="translate(2800 0) rotate(90)"');
    expect(svg).not.toContain('transform="matrix(0 1 1 0 0 0)"');
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
    is_vacuum: false,
    regular_cut_number: '30-4',
    vacuum_cut_number: null,
    ...overrides,
  };
}
