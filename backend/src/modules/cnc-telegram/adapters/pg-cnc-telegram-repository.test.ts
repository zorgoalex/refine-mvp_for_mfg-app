import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgCncTelegramRepository } from './pg-cnc-telegram-repository';

describe('PgCncTelegramRepository', () => {
  it('uses database current date for today when caller omits date', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/SELECT CURRENT_DATE::text AS workday/i.test(text)) {
          return { rows: [{ workday: '2026-07-24' }] };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user() });

    expect(result.workday).toBe('2026-07-24');
    expect(queries[1]?.params).toEqual(['2026-07-24']);
  });

  it('ingests structured packets with idempotency, audit and outbox writes', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.ingest({
      currentUser: user(),
      dto: ingestDto(),
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(result).toMatchObject({
      applied: true,
      ignoredStaleSourceVersion: false,
      auditId: 'audit-1',
      packet: {
        itemCount: 1,
        itemQuantityTotal: 4,
        sourceCreatedAt: '2026-07-24T07:59:00.000Z',
      },
    });
    expect(sql).toContain('INSERT INTO command_idempotency_keys');
    expect(sql).toContain('INSERT INTO audit_log');
    expect(sql).toContain('INSERT INTO outbox_events');
    expect(sql).toContain('UPDATE command_idempotency_keys');
    expect(sql).toContain('FROM unnest($1::bigint[], $2::bigint[])');
    expect(sql).not.toMatch(/\b(raw_gcode|screenshot_path|file_path)\b/i);
    const idempotencyInsert = queries.find((query) =>
      /INSERT INTO command_idempotency_keys/i.test(query.text),
    );
    expect(idempotencyInsert?.params).not.toContain('request-cnc-1');
    const packetInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packets/i.test(query.text),
    );
    expect(packetInsert?.params[5]).toBe('2026-07-24T08:00:00.000Z');
    expect(packetInsert?.params[6]).toBe('2026-07-24T07:59:00.000Z');
    expect(packetInsert?.params[18]).toBe('2026-07-24T08:00:00.000Z');
  });

  it('uses source creation time when Telegram update time is absent', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = ingestDto();
    delete (dto.source as { updatedAt?: string }).updatedAt;

    await repo.ingest({
      currentUser: user(),
      dto,
      requestId: 'request-cnc-1',
    });

    const packetInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packets/i.test(query.text),
    );
    expect(packetInsert?.params[5]).toBe('2026-07-24T07:59:00.000Z');
    expect(packetInsert?.params[6]).toBe('2026-07-24T07:59:00.000Z');
    expect(packetInsert?.params[18]).toBe('2026-07-24T07:59:00.000Z');
  });

  it('returns only posted and completed columns for the daily CNC board', async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [
          packetRow({
            packet_id: '00000000-0000-0000-0000-000000000011',
            completion_status: 'pending',
            thumbs_up: false,
            parse_status: 'needs_review',
          }),
          packetRow({
            packet_id: '00000000-0000-0000-0000-000000000012',
            completion_status: 'completed',
            thumbs_up: true,
          }),
        ],
      })),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.map((column) => [column.key, column.title, column.total])).toEqual([
      ['parsed', 'Файлы на станке', 1],
      ['completed', 'Выполнено', 1],
    ]);
  });

  it('hides noisy RapidOCR warning in the daily CNC board response', async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [
          packetRow({
            analysis_warnings_json: [
              'RapidOCR found text, but no detail rows with order and size',
              'Real operator-facing warning',
            ],
          }),
        ],
      })),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns[1]?.packets[0]?.analysisWarnings).toEqual([
      'Real operator-facing warning',
    ]);
  });

  it('keeps sheet image metadata when updating a completed packet', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: 'sha256:old',
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:completed-image-update',
        source: { ...ingestDto().source, version: 2 },
        thumbsUp: true,
        sheetImage: {
          storageKey: 'tg_100_10.jpg',
          contentType: 'image/jpeg',
          sizeBytes: 12345,
        },
      },
      requestId: 'request-cnc-1',
    });

    const update = queries.find((query) => /UPDATE cnc_telegram_packets/i.test(query.text));
    expect(update?.text).toContain('sheet_image_storage_key = $13');
    expect(update?.text).not.toContain('THEN NULL');
    expect(update?.params[12]).toBe('tg_100_10.jpg');
    expect(update?.params[13]).toBe('image/jpeg');
    expect(update?.params[14]).toBe(12345);
  });

  it('fills missing item matches from unique ERP detail size', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2690',
                order_id: 2690,
                detail_id: 9006,
                detail_number: 6,
                width: 500,
                height: 350,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:size-match',
        items: [
          {
            sourceItemKey: '2690:none:500x350',
            orderName: '2690',
            detailNumber: null,
            widthMm: 500,
            heightMm: 350,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.71,
            matchStatus: 'unmatched' as const,
            reviewNote: 'OCR did not read detail number',
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[3]).toBe(6);
    expect(itemInsert?.params[9]).toBe(2690);
    expect(itemInsert?.params[10]).toBe(9006);
    expect(itemInsert?.params[11]).toBe('matched');
    expect(itemInsert?.params[12]).toBeNull();
  });

  it('aggregates repeated rows only after they resolve to the same ERP detail', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2689',
                order_id: 2689,
                detail_id: 9031,
                detail_number: 31,
                width: 497,
                height: 477,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:aggregate-after-match',
        items: [
          {
            sourceItemKey: '2689:31:497x477',
            orderName: '2689',
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            quantity: 3,
            source: 'ocr' as const,
            confidence: 0.93,
            matchStatus: 'unmatched' as const,
          },
          {
            sourceItemKey: '2689:none:497x477',
            orderName: '2689',
            detailNumber: null,
            widthMm: 497,
            heightMm: 477,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.64,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInserts = queries.filter((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0]?.params[3]).toBe(31);
    expect(itemInserts[0]?.params[6]).toBe(4);
    expect(itemInserts[0]?.params[9]).toBe(2689);
    expect(itemInserts[0]?.params[10]).toBe(9031);
    expect(itemInserts[0]?.params[11]).toBe('matched');
  });

  it('does not guess detail numbers for ambiguous ERP sizes', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2677',
                order_id: 2677,
                detail_id: 9010,
                detail_number: 10,
                width: 2297,
                height: 390,
              },
              {
                order_key: '2677',
                order_id: 2677,
                detail_id: 9011,
                detail_number: 11,
                width: 2297,
                height: 390,
              },
            ],
          };
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return { rows: [] };
        }
        if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
          return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow()] };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          return { rows: [{ audit_id: 'audit-1' }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await repo.ingest({
      currentUser: user(),
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:ambiguous-size',
        items: [
          {
            sourceItemKey: '2677:none:2297x390',
            orderName: '2677',
            detailNumber: null,
            widthMm: 2297,
            heightMm: 390,
            quantity: 1,
            source: 'ocr' as const,
            confidence: 0.68,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[3]).toBeNull();
    expect(itemInsert?.params[9]).toBeNull();
    expect(itemInsert?.params[10]).toBeNull();
    expect(itemInsert?.params[11]).toBe('unmatched');
  });

  it('does not consult ERP resolver before same-version payload conflict checks', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          throw new Error('resolver should not run before source-version conflict checks');
        }
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: 'sha256:different-raw-payload',
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);

    await expect(repo.ingest({
      currentUser: user(),
      dto: ingestDto(),
      requestId: 'request-cnc-1',
    })).rejects.toMatchObject({ code: 'SOURCE_VERSION_CONFLICT' });

    expect(queries.some((query) => /FROM orders o\s+JOIN order_details od/i.test(query.text))).toBe(false);
  });
});

function user(): CurrentUser {
  return {
    id: '42',
    username: 'operator',
    role: 'operator',
    roleId: 11,
    permissions: ['orders.view', 'cut.manage'],
  };
}

function ingestDto() {
  return {
    idempotencyKey: 'cnc:test:repo',
    externalPacketKey: 'chat:-100:message:10',
    source: {
      chatId: '-100',
      messageId: 10,
      version: 1,
      createdAt: '2026-07-24T07:59:00.000Z',
      updatedAt: '2026-07-24T08:00:00.000Z',
    },
    workday: '2026-07-24',
    machine: 'CNC#1',
    programName: 'CNC#1_2689-HDF.TXT',
    materialName: 'ХДФ',
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
        source: 'ocr' as const,
        confidence: 0.94,
        matchOrderId: 2689,
        matchDetailId: 3101,
        matchStatus: 'matched' as const,
      },
    ],
  };
}

function packetRow(overrides: Partial<ReturnType<typeof packetRowBase>> = {}) {
  return { ...packetRowBase(), ...overrides };
}

function packetRowBase() {
  return {
    packet_id: '00000000-0000-0000-0000-000000000001',
    external_packet_key: 'chat:-100:message:10',
    source_chat_id: '-100',
    source_message_id: 10,
    source_thread_id: null,
    source_version: 1,
    source_created_at: '2026-07-24T07:59:00.000Z',
    source_updated_at: '2026-07-24T08:00:00.000Z',
    workday: '2026-07-24',
    machine: 'CNC#1',
    program_name: 'CNC#1_2689-HDF.TXT',
    material_name: 'ХДФ',
    sheet_image_storage_key: 'tg_100_10.jpg',
    sheet_image_content_type: 'image/jpeg',
    sheet_image_size_bytes: 12345,
    parse_status: 'parsed',
    completion_status: 'completed',
    thumbs_up: true,
    completed_at: '2026-07-24T08:00:00.000Z',
    rework: false,
    comments_json: ['ХДФ!!!'],
    tools_json: [{ toolNumber: 8, spindleRpm: 15000 }],
    doweling_links_json: [],
    analysis_warnings_json: [],
    ocr_engine: 'glm-ocr-0.9b-q8-llama.cpp',
    parser_version: 'cnc-telegram-structured-v1',
    updated_at: '2026-07-24T08:00:10.000Z',
    packet_item_id: '00000000-0000-0000-0000-000000000002',
    source_item_key: '2689:31:497x477',
    order_name: '2689',
    detail_number: 31,
    width_mm: 497,
    height_mm: 477,
    quantity: 4,
    item_source: 'ocr',
    confidence: 0.94,
    match_order_id: 2689,
    match_detail_id: 3101,
    match_status: 'matched',
    review_note: null,
  };
}
