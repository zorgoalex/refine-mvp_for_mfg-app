import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  parseAutoCutStatusConfigure,
  parseDateQuery,
  parseIdempotencyKey,
  parseManualSvgCommentPreset,
  parseManualSvgUpload,
  parseStructuredIngest,
  parseTodayQuery,
} from './cnc-telegram.controller';

describe('CncTelegramController parsing', () => {
  it('accepts structured packet ingest and rejects raw fields', () => {
    const payload = structuredPayload();

    expect(parseStructuredIngest(payload, 'cnc:test:1')).toMatchObject({
      idempotencyKey: 'cnc:test:1',
      externalPacketKey: 'chat:-100:message:10',
      source: { version: 2 },
      cuttingSequenceNo: 7,
      items: [{ orderName: '2689', detailNumber: 31 }],
    });

    expect(() =>
      parseStructuredIngest({
        ...payload,
        rawGcodeText: 'G1 X0 Y0',
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
    expect(() =>
      parseStructuredIngest({
        ...payload,
        idempotencyKey: 'cnc:test:body',
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
  });

  it('reads idempotency only from the Idempotency-Key header', () => {
    expect(parseIdempotencyKey('  cnc:test:header  ')).toBe('cnc:test:header');
    expect(parseIdempotencyKey(['cnc:test:first', 'cnc:test:second'])).toBe('cnc:test:first');
    expect(() => parseIdempotencyKey(undefined)).toThrow(ApiError);
    expect(() => parseIdempotencyKey('short')).toThrow(ApiError);
  });

  it('accepts only a strict boolean auto-cut status setting body', () => {
    expect(parseAutoCutStatusConfigure({ enabled: true })).toBe(true);
    expect(parseAutoCutStatusConfigure({ enabled: false })).toBe(false);
    expect(() => parseAutoCutStatusConfigure({ enabled: 'true' })).toThrow(ApiError);
    expect(() => parseAutoCutStatusConfigure({ enabled: true, extra: true })).toThrow(ApiError);
  });

  it('keeps match ids coherent in structured rows', () => {
    const payload = structuredPayload();
    expect(() =>
      parseStructuredIngest({
        ...payload,
        items: [{
          ...payload.items[0],
          matchStatus: 'matched',
          matchDetailId: null,
        }],
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
    expect(() =>
      parseStructuredIngest({
        ...payload,
        items: [{
          ...payload.items[0],
          matchStatus: 'unmatched',
          matchOrderId: 2689,
          matchDetailId: null,
        }],
      }, 'cnc:test:1'),
    ).toThrow(ApiError);
  });

  it('accepts parsed SVG cut layout geometry', () => {
    const parsed = parseStructuredIngest({
      ...structuredPayload(),
      cutLayout: {
        status: 'valid',
        sheet: { widthMm: 2070, heightMm: 2800 },
        acceptedItemCount: 1,
        items: [{
          orderName: '2689',
          detailNumber: 31,
          widthMm: 497,
          heightMm: 477,
          xMm: 10,
          yMm: 20,
          placedWidthMm: 477,
          placedHeightMm: 497,
          rotated: true,
        }],
      },
    }, 'cnc:test:1');

    expect(parsed.cutLayout).toMatchObject({
      status: 'valid',
      reasons: [],
      sheet: { widthMm: 2070, heightMm: 2800 },
      items: [{ quantity: 1, rotated: true }],
    });
  });

  it('accepts manual SVG upload payload and normalizes selected order allowlist', () => {
    const parsed = parseManualSvgUpload({
      selectedOrderIds: [42, 7, 42],
      createMdfMachineFileCard: true,
      requestedCutJobId: 777,
      svgContentHash: 'a'.repeat(64),
      programName: 'manual.svg',
      cutLayout: {
        status: 'valid',
        reasons: [],
        sheet: { widthMm: 2070, heightMm: 2800 },
        acceptedItemCount: 1,
        items: [{
          orderName: '2689',
          detailNumber: 31,
          widthMm: 497,
          heightMm: 477,
          quantity: 1,
          xMm: 10,
          yMm: 20,
          placedWidthMm: 497,
          placedHeightMm: 477,
          rotated: false,
          visualLabel: { rawLines: ['2689', '# 31', '497*477'] },
        }],
      },
      items: [structuredPayload().items[0]],
    }, 'manual-svg:test:1');

    expect(parsed).toMatchObject({
      idempotencyKey: 'manual-svg:test:1',
      selectedOrderIds: [7, 42],
      createMdfMachineFileCard: true,
      matchMode: 'order_details',
      validationMode: 'strict',
      requestedCutJobId: 777,
      svgContentHash: 'a'.repeat(64),
      cutLayout: {
        items: [{ visualLabel: { rawLines: ['2689', '# 31', '497*477'] } }],
      },
    });

    expect(parseManualSvgUpload({
      ...manualSvgUploadPayload(),
      matchMode: 'informational',
      validationMode: 'lenient',
    }, 'manual-svg:test:2')).toMatchObject({
      matchMode: 'informational',
      validationMode: 'lenient',
    });
  });

  it('accepts manual SVG source files and Telegram send options', () => {
    const parsed = parseManualSvgUpload({
      ...manualSvgUploadPayload(),
      sourceFiles: [
        manualSvgUploadFile('svg', 'CNC#1_2777+2723-HDF.svg', 'image/svg+xml', '<svg></svg>'),
        manualSvgUploadFile('gcode', 'CNC#1_2777+2723-HDF.nc', 'text/plain', 'G01 X1'),
      ],
      telegramSend: {
        enabled: true,
        message: 'Фрезы для ХДФ: 8',
      },
      generatedScreenshot: {
        contrast: 1.85,
      },
    }, 'manual-svg:test:files');

    expect(parsed.sourceFiles).toHaveLength(2);
    expect(parsed.sourceFiles?.[0]).toMatchObject({
      kind: 'svg',
      fileName: 'CNC#1_2777+2723-HDF.svg',
      sha256: createHash('sha256').update('<svg></svg>').digest('hex'),
    });
    expect(parsed.telegramSend).toEqual({
      enabled: true,
      message: 'Фрезы для ХДФ: 8',
    });
    expect(parsed.generatedScreenshot).toEqual({ contrast: 1.85 });

    expect(() => parseManualSvgUpload({
      ...manualSvgUploadPayload(),
      sourceFiles: [
        manualSvgUploadFile('svg', 'one.svg', 'image/svg+xml', '<svg></svg>'),
        manualSvgUploadFile('svg', 'two.svg', 'image/svg+xml', '<svg></svg>'),
      ],
      telegramSend: { enabled: true },
    }, 'manual-svg:test:duplicate')).toThrow(ApiError);

    expect(() => parseManualSvgUpload({
      ...manualSvgUploadPayload(),
      generatedScreenshot: { contrast: 6.1 },
    }, 'manual-svg:test:bad-contrast')).toThrow(ApiError);

    expect(parseManualSvgUpload({
      ...manualSvgUploadPayload(),
      generatedScreenshot: { contrast: 6 },
    }, 'manual-svg:test:max-contrast').generatedScreenshot).toEqual({ contrast: 6 });
  });

  it('rejects manual SVG upload without selected orders or valid layout', () => {
    expect(() =>
      parseManualSvgUpload({
        selectedOrderIds: [],
        createMdfMachineFileCard: false,
        svgContentHash: 'a'.repeat(64),
        rawSvg: '<svg />',
        cutLayout: { status: 'invalid', reasons: ['bad'], sheet: null, items: [] },
        items: [],
      }, 'manual-svg:test:1'),
    ).toThrow(ApiError);

    expect(() =>
      parseManualSvgUpload({
        ...manualSvgUploadPayload(),
        requestedCutJobId: 0,
      }, 'manual-svg:test:1'),
    ).toThrow(ApiError);

    expect(() =>
      parseManualSvgUpload({
        ...manualSvgUploadPayload(),
        cutLayout: {
          status: 'invalid',
          reasons: ['bad geometry'],
          sheet: null,
          items: [],
        },
      }, 'manual-svg:test:1'),
    ).toThrow(ApiError);
  });

  it('accepts invalid manual SVG layout in lenient mode when recognized details are present', () => {
    const parsed = parseManualSvgUpload({
      ...manualSvgUploadPayload(),
      validationMode: 'lenient',
      cutLayout: {
        ...manualSvgUploadPayload().cutLayout,
        status: 'invalid',
        reasons: ['Для верхней подписи 2790 #1 не найден контур детали; деталь создана по подписи'],
      },
    }, 'manual-svg:test:lenient-invalid');

    expect(parsed).toMatchObject({
      validationMode: 'lenient',
      cutLayout: {
        status: 'invalid',
        items: [expect.objectContaining({ orderName: '2689', detailNumber: 31 })],
      },
    });
  });

  it('accepts manual SVG comment presets and rejects extra fields', () => {
    expect(parseManualSvgCommentPreset({
      label: 'Переделка',
      commentText: 'переделка',
      category: 'rework',
    })).toMatchObject({ label: 'Переделка', commentText: 'переделка' });

    expect(() => parseManualSvgCommentPreset({
      label: 'X',
      commentText: 'Y',
      rawSql: 'DROP',
    })).toThrow(ApiError);
  });

  it('validates date-only query values', () => {
    expect(parseDateQuery(undefined)).toBeNull();
    expect(parseDateQuery('2026-07-24')).toBe('2026-07-24');
    expect(() => parseDateQuery('24.07.2026')).toThrow(ApiError);
    expect(() => parseDateQuery('2026-02-30')).toThrow(ApiError);
  });

  it('validates today board range query values', () => {
    expect(parseTodayQuery({ dateFrom: '2026-07-18', dateTo: '2026-07-24' })).toEqual({
      workday: null,
      workdayFrom: '2026-07-18',
      workdayTo: '2026-07-24',
    });
    expect(() =>
      parseTodayQuery({
        date: '2026-07-24',
        dateFrom: '2026-07-18',
        dateTo: '2026-07-24',
      }),
    ).toThrow(ApiError);
    expect(() => parseTodayQuery({ dateFrom: '2026-07-24' })).toThrow(ApiError);
    expect(() =>
      parseTodayQuery({ dateFrom: '2026-07-24', dateTo: '2026-07-18' }),
    ).toThrow(ApiError);
  });
});

function structuredPayload() {
  return {
    externalPacketKey: 'chat:-100:message:10',
    source: {
      chatId: '-100',
      messageId: 10,
      version: 2,
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
    workday: '2026-07-24',
    cuttingSequenceNo: 7,
    machine: 'CNC#1',
    programName: 'CNC#1_2689-HDF.TXT',
    materialName: 'ХДФ',
    parseStatus: 'parsed',
    thumbsUp: true,
    comments: ['ХДФ!!!'],
    tools: [{ toolNumber: 8, spindleRpm: 15000 }],
    items: [
      {
        sourceItemKey: '2689:31:497x477',
        orderName: '2689',
        detailNumber: 31,
        widthMm: 497,
        heightMm: 477,
        quantity: 4,
        source: 'ocr',
        confidence: 0.94,
        matchOrderId: 2689,
        matchDetailId: 3101,
        matchStatus: 'matched',
      },
    ],
  };
}

function manualSvgUploadPayload() {
  return {
    selectedOrderIds: [42, 7, 42],
    createMdfMachineFileCard: true,
    svgContentHash: 'a'.repeat(64),
    programName: 'manual.svg',
    cutLayout: {
      status: 'valid' as const,
      reasons: [],
      sheet: { widthMm: 2070, heightMm: 2800 },
      acceptedItemCount: 1,
      items: [{
        orderName: '2689',
        detailNumber: 31,
        widthMm: 497,
        heightMm: 477,
        quantity: 1,
        xMm: 10,
        yMm: 20,
        placedWidthMm: 497,
        placedHeightMm: 477,
        rotated: false,
      }],
    },
    items: [structuredPayload().items[0]],
  };
}

function manualSvgUploadFile(
  kind: 'svg' | 'gcode' | 'screenshot',
  fileName: string,
  contentType: string,
  content: string,
) {
  const body = Buffer.from(content);
  return {
    kind,
    fileName,
    contentType,
    sizeBytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    base64Content: body.toString('base64'),
  };
}
