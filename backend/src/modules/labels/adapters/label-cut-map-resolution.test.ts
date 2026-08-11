import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { DatabaseClient } from '../../../database/database.types';
import { renderSvgPages } from '../application/label-renderer';
import type { LabelRow } from '../application/label-row-builder';
import type { LabelTemplateDto } from '../application/labels.types';
import {
  closePreparedTelegramImages,
  TELEGRAM_IMAGE_LIMITS,
} from '../../cnc-telegram/application/telegram-media-reader';
import { insertGenerationTelegramSources, resolveLabelCutMaps } from './pg-labels-repository';

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
    expect(resolved.assets.get('cut_result:600')).toEqual({
      svg: expect.stringContaining('<svg'),
      isVacuum: false,
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_array_elements(r.snapshot_job -> 'items')"),
      [[700], 20],
    );
  });

  it('binds a vacuum placement with the Cyrillic cut-number prefix', async () => {
    const client = databaseReturning(placementRow({
      is_vacuum: true,
      regular_cut_number: null,
      vacuum_cut_number: 'В-30-4',
    }));
    const resolved = await resolveLabelCutMaps(
      client,
      template(),
      [labelRow()],
      [{ detailId: 10, copyIndex: 1, cutResultPlacementId: 700 }],
      20,
      'bath',
    );

    expect(resolved.rows[0].cutMap).toMatchObject({
      cutResultPlacementId: 700,
      cutNumber: 'В-30-4',
    });
    expect(resolved.rows[0].values).toMatchObject({ 'cut.number': 'В-30-4' });
    expect(resolved.assets.get('cut_result:600')).toMatchObject({ isVacuum: true });
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

  it('keeps SVG rows while validating screenshot options without preparing render assets', async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-options-'));
    const image = await sharp({
      create: { width: 16, height: 8, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    await writeFile(join(mediaDir, 'sheet.png'), image);
    const client = databaseReturningSequence(
      [],
      [{
        telegram_label_sheet_map_id: 901,
        telegram_label_placement_id: 902,
        packet_id: '11111111-1111-4111-8111-111111111111',
        source_version: 3,
        source_message_id: 44,
        layout_digest: 'sha256:layout',
        order_id: 20,
        order_detail_id: 10,
        instance: 1,
        sheet_width_mm: 2800,
        sheet_height_mm: 2070,
        base_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2800 2070"></svg>',
        x_mm: 10,
        y_mm: 20,
        width_mm: 500,
        height_mm: 300,
      }],
      [{
        packet_id: '22222222-2222-4222-8222-222222222222',
        source_version: 4,
        source_message_id: 45,
        order_id: 20,
        order_detail_id: 11,
        instance: 1,
        sheet_image_storage_key: 'sheet.png',
        sheet_image_content_type: 'image/png',
        sheet_image_size_bytes: image.length,
        evidence_quantity: 1,
        evidence_eligible: true,
      }],
    );
    try {
      const resolved = await resolveLabelCutMaps(
        client,
        template(),
        [labelRow(), labelRow({ rowIndex: 2, detailId: 11 })],
        [],
        20,
        'regular',
        { enabled: true, capability: 'v1', mediaDir, imageMode: 'validate' },
      );

      expect(resolved.rows[0].cutMap).toMatchObject({ source: 'telegram_svg', telegramLabelSheetMapId: 901 });
      expect(resolved.rows[1].cutMap).toBeUndefined();
      expect(resolved.assets.has('telegram_svg:901')).toBe(true);
      expect(resolved.imageCandidates.get('20:11:1')).toEqual({
        packetId: '22222222-2222-4222-8222-222222222222',
        sourceMessageId: 45,
      });
      expect(resolved.preparedImages.size).toBe(0);
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it('uses the selected Telegram cutting sequence and sheet size for screenshot fallback labels', async () => {
    const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-cut-number-'));
    const image = await sharp({
      create: { width: 16, height: 24, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    await writeFile(join(mediaDir, 'sheet-47.jpg'), image);
    const client = databaseReturningSequence(
      [],
      [],
      [{
        packet_id: '47474747-4747-4747-8747-474747474747',
        source_version: 2,
        source_message_id: 10847,
        cutting_sequence_no: 47,
        order_id: 20,
        order_detail_id: 10,
        instance: 1,
        sheet_image_storage_key: 'sheet-47.jpg',
        sheet_image_content_type: 'image/jpeg',
        sheet_image_size_bytes: image.length,
        sheet_width_mm: 2070.2,
        sheet_height_mm: 2800.2,
        evidence_quantity: 1,
        evidence_eligible: true,
      }],
    );
    let resolved: Awaited<ReturnType<typeof resolveLabelCutMaps>> | null = null;
    try {
      resolved = await resolveLabelCutMaps(
        client,
        template(),
        [labelRow({
          values: {
            'detail.cut_result_version_no': '30-4',
            'detail.bath_cut_result_version_no': '31-1',
          },
        })],
        [],
        20,
        'regular',
        { enabled: true, capability: 'v1', mediaDir, imageMode: 'prepare' },
      );

      expect(resolved.rows[0].cutMap).toMatchObject({
        source: 'telegram_image',
        cutNumber: '№47',
        cutJobName: 'Раскрой №47',
        sheetWidthMm: 2070.2,
        sheetHeightMm: 2800.2,
      });
      expect(resolved.rows[0].values).toMatchObject({
        'cut.number': '№47',
        'detail.cut_result_version_no': '№47',
        'detail.bath_cut_result_version_no': '31-1',
      });
      const svg = renderSvgPages(template(), resolved.rows, resolved.assets).pages[0];
      expect(svg).toContain('data-cut-number="№47"');
      expect(svg).toContain('viewBox="0 0 2800.2 2070.2"');
      expect(svg).toContain('transform="matrix(0 1 1 0 0 0)"');
    } finally {
      if (resolved) await closePreparedTelegramImages(resolved.preparedImages.values());
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it('marks every requested copy unavailable when newest screenshot winner is ambiguous and quantity one', async () => {
    const newest = {
      packet_id: '33333333-3333-4333-8333-333333333333',
      source_version: 5,
      source_message_id: 46,
      order_id: 20,
      order_detail_id: 10,
      sheet_image_storage_key: 'newest.png',
      sheet_image_content_type: 'image/png',
      sheet_image_size_bytes: 100,
      evidence_quantity: 1,
      evidence_eligible: false,
    };
    const client = databaseReturningSequence(
      [],
      [],
      [{ ...newest, instance: 1 }, { ...newest, instance: 2 }],
    );

    const resolved = await resolveLabelCutMaps(
      client,
      template(),
      [labelRow({ copyCount: 2 }), labelRow({ rowIndex: 2, copyIndex: 2, copyCount: 2 })],
      [],
      20,
      'regular',
      { enabled: true, capability: 'v1', mediaDir: '/unused', imageMode: 'validate' },
    );

    expect(resolved.rows.every((row) => row.cutMap === undefined)).toBe(true);
    expect(resolved.unavailable.get('20:10:1')).toBe('ambiguous_evidence');
    expect(resolved.unavailable.get('20:10:2')).toBe('ambiguous_evidence');
    expect(resolved.imageCandidates.size).toBe(0);
  });

  it.each([null, 'image/jpg'] as const)(
    'accepts compatible stored MIME %s when two packets share one screenshot key',
    async (storedContentType) => {
      const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-shared-valid-'));
      const image = await sharp({
        create: { width: 16, height: 8, channels: 3, background: '#ffffff' },
      }).jpeg().toBuffer();
      await writeFile(join(mediaDir, 'shared.jpg'), image);
      const candidate = {
        source_version: 6,
        source_message_id: 47,
        order_id: 20,
        instance: 1,
        sheet_image_storage_key: 'shared.jpg',
        sheet_image_size_bytes: image.length,
        evidence_quantity: 1,
        evidence_eligible: true,
      };
      const client = databaseReturningSequence(
        [],
        [],
        [
          {
            ...candidate,
            packet_id: '44444444-4444-4444-8444-444444444441',
            order_detail_id: 10,
            sheet_image_content_type: 'image/jpeg',
          },
          {
            ...candidate,
            packet_id: '44444444-4444-4444-8444-444444444442',
            order_detail_id: 11,
            sheet_image_content_type: storedContentType,
          },
        ],
      );
      try {
        const resolved = await resolveLabelCutMaps(
          client,
          template(),
          [labelRow(), labelRow({ rowIndex: 2, detailId: 11 })],
          [],
          20,
          'regular',
          { enabled: true, capability: 'v1', mediaDir, imageMode: 'validate' },
        );

        expect([...resolved.imageCandidates.keys()]).toEqual(['20:10:1', '20:11:1']);
        expect(resolved.unavailable.size).toBe(0);
      } finally {
        await rm(mediaDir, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['validate', 'mime'],
    ['validate', 'size'],
    ['prepare', 'mime'],
    ['prepare', 'size'],
  ] as const)(
    'rejects shared-key packet metadata mismatch in %s mode (%s)',
    async (imageMode, mismatch) => {
      const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-shared-invalid-'));
      const image = await sharp({
        create: { width: 16, height: 8, channels: 3, background: '#ffffff' },
      }).jpeg().toBuffer();
      await writeFile(join(mediaDir, 'shared.jpg'), image);
      const candidate = {
        source_version: 7,
        source_message_id: 48,
        order_id: 20,
        instance: 1,
        sheet_image_storage_key: 'shared.jpg',
        sheet_image_content_type: 'image/jpeg',
        sheet_image_size_bytes: image.length,
        evidence_quantity: 1,
        evidence_eligible: true,
      };
      const client = databaseReturningSequence(
        [],
        [],
        [
          {
            ...candidate,
            packet_id: '55555555-5555-4555-8555-555555555551',
            order_detail_id: 10,
          },
          {
            ...candidate,
            packet_id: '55555555-5555-4555-8555-555555555552',
            order_detail_id: 11,
            ...(mismatch === 'mime'
              ? { sheet_image_content_type: 'image/png' }
              : { sheet_image_size_bytes: image.length + 1 }),
          },
        ],
      );
      let resolved: Awaited<ReturnType<typeof resolveLabelCutMaps>> | null = null;
      try {
        resolved = await resolveLabelCutMaps(
          client,
          template(),
          [labelRow(), labelRow({ rowIndex: 2, detailId: 11 })],
          [],
          20,
          'regular',
          { enabled: true, capability: 'v1', mediaDir, imageMode },
        );

        expect(resolved.unavailable.get('20:11:1')).toBe('invalid_media');
        expect(resolved.rows[1].cutMap).toBeUndefined();
        if (imageMode === 'validate') {
          expect([...resolved.imageCandidates.keys()]).toEqual(['20:10:1']);
        } else {
          expect(resolved.rows[0].cutMap).toMatchObject({ source: 'telegram_image' });
        }
      } finally {
        if (resolved) await closePreparedTelegramImages(new Set(resolved.preparedImages.values()));
        await rm(mediaDir, { recursive: true, force: true });
      }
    },
  );

  it.each(['validate', 'prepare'] as const)(
    'does not let oversized packet metadata poison a shared key in %s mode',
    async (imageMode) => {
      const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-shared-limit-'));
      const image = await sharp({
        create: { width: 16, height: 8, channels: 3, background: '#ffffff' },
      }).jpeg().toBuffer();
      await writeFile(join(mediaDir, 'shared.jpg'), image);
      const candidate = {
        source_version: 8,
        source_message_id: 49,
        order_id: 20,
        instance: 1,
        sheet_image_storage_key: 'shared.jpg',
        sheet_image_content_type: 'image/jpeg',
        evidence_quantity: 1,
        evidence_eligible: true,
      };
      const client = databaseReturningSequence(
        [],
        [],
        [
          {
            ...candidate,
            packet_id: '66666666-6666-4666-8666-666666666661',
            order_detail_id: 10,
            sheet_image_size_bytes: TELEGRAM_IMAGE_LIMITS.maxSourceBytes + 1,
          },
          {
            ...candidate,
            packet_id: '66666666-6666-4666-8666-666666666662',
            order_detail_id: 11,
            sheet_image_size_bytes: image.length,
          },
        ],
      );
      let resolved: Awaited<ReturnType<typeof resolveLabelCutMaps>> | null = null;
      try {
        resolved = await resolveLabelCutMaps(
          client,
          template(),
          [labelRow(), labelRow({ rowIndex: 2, detailId: 11 })],
          [],
          20,
          'regular',
          { enabled: true, capability: 'v1', mediaDir, imageMode },
        );

        expect(resolved.unavailable.get('20:10:1')).toBe('invalid_media');
        if (imageMode === 'validate') {
          expect([...resolved.imageCandidates.keys()]).toEqual(['20:11:1']);
        } else {
          expect(resolved.rows[1].cutMap).toMatchObject({ source: 'telegram_image' });
        }
      } finally {
        if (resolved) await closePreparedTelegramImages(new Set(resolved.preparedImages.values()));
        await rm(mediaDir, { recursive: true, force: true });
      }
    },
  );

  it('closes a prepared handle when packet metadata rejects the only candidate', async () => {
    if (process.platform !== 'linux') return;
    const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-handle-close-'));
    const imagePath = join(mediaDir, 'sheet.jpg');
    const image = await sharp({
      create: { width: 16, height: 8, channels: 3, background: '#ffffff' },
    }).jpeg().toBuffer();
    await writeFile(imagePath, image);
    const client = databaseReturningSequence(
      [],
      [],
      [{
        packet_id: '77777777-7777-4777-8777-777777777777',
        source_version: 9,
        source_message_id: 50,
        order_id: 20,
        order_detail_id: 10,
        instance: 1,
        sheet_image_storage_key: 'sheet.jpg',
        sheet_image_content_type: 'image/png',
        sheet_image_size_bytes: image.length,
        evidence_quantity: 1,
        evidence_eligible: true,
      }],
    );
    try {
      const resolved = await resolveLabelCutMaps(
        client,
        template(),
        [labelRow()],
        [],
        20,
        'regular',
        { enabled: true, capability: 'v1', mediaDir, imageMode: 'prepare' },
      );

      expect(resolved.preparedImages.size).toBe(0);
      expect(await openFileDescriptorTargets(imagePath)).toEqual([]);
    } finally {
      await rm(mediaDir, { recursive: true, force: true });
    }
  });

  it.each([null, 'image/jpg'] as const)(
    'keeps screenshot preview and generation consistent for stored MIME %s',
    async (storedContentType) => {
      const mediaDir = await mkdtemp(join(tmpdir(), 'telegram-label-mime-'));
      const image = await sharp({
        create: { width: 16, height: 8, channels: 3, background: '#ffffff' },
      }).jpeg().toBuffer();
      await writeFile(join(mediaDir, 'sheet.jpg'), image);
      const packetId = '44444444-4444-4444-8444-444444444444';
      const previewClient = databaseReturningSequence(
        [],
        [],
        [{
          packet_id: packetId,
          source_version: 6,
          source_message_id: 47,
          order_id: 20,
          order_detail_id: 10,
          instance: 1,
          sheet_image_storage_key: 'sheet.jpg',
          sheet_image_content_type: storedContentType,
          sheet_image_size_bytes: image.length,
          evidence_quantity: 1,
          evidence_eligible: true,
        }],
      );
      let resolved: Awaited<ReturnType<typeof resolveLabelCutMaps>> | null = null;
      try {
        resolved = await resolveLabelCutMaps(
          previewClient,
          template(),
          [labelRow()],
          [],
          20,
          'regular',
          { enabled: true, capability: 'v1', mediaDir, imageMode: 'prepare' },
        );
        expect(resolved.rows[0].cutMap).toMatchObject({ source: 'telegram_image', packetId });

        const generationQuery = vi.fn(async (sql: string) => {
          if (sql.includes('FROM cnc_telegram_packets')) {
            return {
              rows: [{
                source_version: 6,
                sheet_image_storage_key: 'sheet.jpg',
                sheet_image_content_type: storedContentType,
                sheet_image_size_bytes: image.length,
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 1 };
        });
        const generationClient = { query: generationQuery } as unknown as DatabaseClient;

        await expect(insertGenerationTelegramSources(
          generationClient,
          77,
          resolved.rows,
          resolved.preparedImages,
        )).resolves.toBeUndefined();
        expect(generationQuery).toHaveBeenCalledWith(
          expect.stringContaining('INSERT INTO label_generation_media_asset'),
          expect.any(Array),
        );
      } finally {
        if (resolved) await closePreparedTelegramImages(resolved.preparedImages.values());
        await rm(mediaDir, { recursive: true, force: true });
      }
    },
  );
});

function databaseReturning(row?: ReturnType<typeof placementRow>): DatabaseClient & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn().mockResolvedValue({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }),
  } as unknown as DatabaseClient & { query: ReturnType<typeof vi.fn> };
}

function databaseReturningSequence(...rows: Array<Array<Record<string, unknown>>>): DatabaseClient & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  for (const resultRows of rows) {
    query.mockResolvedValueOnce({ rows: resultRows, rowCount: resultRows.length });
  }
  return { query } as unknown as DatabaseClient & { query: ReturnType<typeof vi.fn> };
}

async function openFileDescriptorTargets(expectedPath: string): Promise<string[]> {
  const entries = await readdir('/proc/self/fd');
  const targets = await Promise.all(entries.map(async (entry) => {
    try {
      return await readlink(`/proc/self/fd/${entry}`);
    } catch {
      return null;
    }
  }));
  return targets.filter((target): target is string => target === expectedPath);
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
