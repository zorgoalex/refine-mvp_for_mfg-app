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
      packet: { itemCount: 1, itemQuantityTotal: 4 },
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

function packetRow() {
  return {
    packet_id: '00000000-0000-0000-0000-000000000001',
    external_packet_key: 'chat:-100:message:10',
    source_chat_id: '-100',
    source_message_id: 10,
    source_thread_id: null,
    source_version: 1,
    source_updated_at: '2026-07-24T08:00:00.000Z',
    workday: '2026-07-24',
    machine: 'CNC#1',
    program_name: 'CNC#1_2689-HDF.TXT',
    material_name: 'ХДФ',
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
