import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import {
  cncWholeOrderIds,
  cncWholeOrderKeys,
  PgCncTelegramRepository,
} from './pg-cnc-telegram-repository';

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
    expect(queries[1]?.params).toEqual(['2026-07-24', '2026-07-24']);
  });

  it('queries packets and bath readiness for a date range', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({
      currentUser: user(),
      workdayFrom: '2026-07-18',
      workdayTo: '2026-07-24',
    });

    expect(result.workday).toBe('2026-07-24');
    expect(queries[0]?.text).toContain('p.workday BETWEEN $1::date AND $2::date');
    expect(queries[0]?.params).toEqual(['2026-07-18', '2026-07-24']);
    expect(queries[1]?.text).toContain('p.workday BETWEEN $1::date AND $2::date');
    expect(queries[1]?.params).toEqual(['2026-07-18', '2026-07-24']);
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
        cuttingSequenceNo: 12,
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
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
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
                svg_cut_job_id: 35,
                svg_cut_result_id: 54,
                svg_cut_result_no: 3,
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.map((column) => [column.key, column.title, column.total])).toEqual([
      ['parsed', 'Файлы на станке', 1],
      ['completed', 'Выполнено', 1],
      ['baths', 'Ванны', 0],
      ['baths_ready', 'Готовы к закатке', 0],
      ['completed_laminated', 'Распиленные файлы', 0],
      ['baths_laminated', 'Закатаны/выданы', 0],
    ]);
    expect(queries[0]).toContain('LEFT JOIN cut_result svg_result');
    expect(queries[0]).toContain('svg_result.result_no AS svg_cut_result_no');
    expect(result.columns[1].packets[0]).toMatchObject({
      svgCutJobId: 35,
      svgCutResultId: 54,
      svgCutResultNo: 3,
    });
  });

  it('archives a completed machine file only when every matched detail is laminated or later', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/latest_vacuum_results/i.test(text)) return { rows: [] };
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000031',
                packet_item_id: '00000000-0000-0000-0000-000000000041',
                laminated_or_later: true,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000032',
                packet_item_id: '00000000-0000-0000-0000-000000000042',
                laminated_or_later: true,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000032',
                packet_item_id: '00000000-0000-0000-0000-000000000043',
                source_item_key: '2689:32:497x477',
                detail_number: 32,
                match_detail_id: 3102,
                laminated_or_later: false,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000033',
                packet_item_id: '00000000-0000-0000-0000-000000000044',
                match_status: 'conflict',
                laminated_or_later: true,
              }),
              packetRow({
                packet_id: '00000000-0000-0000-0000-000000000034',
                packet_item_id: '00000000-0000-0000-0000-000000000045',
                match_status: 'needs_review',
                laminated_or_later: true,
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.find((column) => column.key === 'completed')?.packets)
      .toHaveLength(3);
    expect(result.columns.find((column) => column.key === 'completed_laminated')?.packets)
      .toMatchObject([{ packetId: '00000000-0000-0000-0000-000000000031' }]);
    expect(database.query.mock.calls[0]?.[0]).toContain("i.match_status = 'matched'");
  });

  it('lists stored machine-file cutting sequence numbers for an order card', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        return {
          rows: [{
            packet_id: '00000000-0000-0000-0000-000000000021',
            external_packet_key: 'telegram:-100:10',
            cutting_sequence_no: 7,
            source_message_id: 10,
            workday: '2026-07-24',
            program_name: 'CNC#1_2700.TXT',
            material_name: 'МДФ 16мм',
            completion_status: 'pending',
            source_created_at: '2026-07-24T08:00:00.000Z',
            item_quantity_total: 5,
          }],
        };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listOrderCuttingSequences({
      currentUser: user(),
      orderId: 2700,
    });

    expect(queries[0]?.text).toContain('p.cutting_sequence_no IS NOT NULL');
    expect(queries[0]?.text).toContain('COALESCE(i.match_order_id, order_key.order_id) = $1::bigint');
    expect(queries[0]?.params).toEqual([2700]);
    expect(result).toEqual({
      orderId: 2700,
      sequences: [{
        packetId: '00000000-0000-0000-0000-000000000021',
        externalPacketKey: 'telegram:-100:10',
        cuttingSequenceNo: 7,
        sourceMessageId: 10,
        workday: '2026-07-24',
        programName: 'CNC#1_2700.TXT',
        materialName: 'МДФ 16мм',
        completionStatus: 'pending',
        sourceCreatedAt: '2026-07-24T08:00:00.000Z',
        itemQuantityTotal: 5,
      }],
    });
  });

  it('exposes unique ERP order ids for unmatched CNC packet item order names', async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                order_name: '2706',
                item_order_id: 11450,
                match_order_id: null,
                match_detail_id: null,
                match_status: 'unmatched',
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-28' });
    const sql = queries.join('\n');
    const item = result.columns.flatMap((column) => column.packets)
      .flatMap((packet) => packet.items)[0];

    expect(sql).toContain('COALESCE(i.match_order_id, item_order.order_id) AS item_order_id');
    expect(sql).toContain('matched_order.delete_flag');
    expect(sql).toContain('LEFT JOIN orders matched_order');
    expect(sql).toContain('HAVING COUNT(*) = 1');
    expect(item).toMatchObject({
      orderName: '2706',
      orderId: 11450,
      matchOrderId: null,
      matchDetailId: null,
      matchStatus: 'unmatched',
    });
  });

  it('marks packet items linked to soft-deleted matched orders', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                order_name: '2706',
                item_order_id: 11450,
                order_delete_flag: true,
                match_order_id: 11450,
                match_detail_id: 7788,
                match_status: 'matched',
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-28' });
    const item = result.columns.flatMap((column) => column.packets)
      .flatMap((packet) => packet.items)[0];

    expect(item).toMatchObject({
      orderId: 11450,
      matchOrderId: 11450,
      orderDeleted: true,
    });
  });

  it('hides noisy RapidOCR warning in the daily CNC board response', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [
              packetRow({
                analysis_warnings_json: [
                  'RapidOCR found text, but no detail rows with order and size',
                  'Real operator-facing warning',
                ],
              }),
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns[1]?.packets[0]?.analysisWarnings).toEqual([
      'Real operator-facing warning',
    ]);
  });

  it('splits vacuum bath cards by completed detail quantities', async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (/latest_vacuum_results/i.test(text)) {
          return {
            rows: [
              bathPlacementRow({
                cut_result_id: 500,
                cut_job_id: 30,
                result_no: 2,
                order_detail_id: 3101,
                detail_number: 31,
                completed_quantity: 2,
              }),
              bathPlacementRow({
                cut_result_id: 500,
                cut_job_id: 30,
                result_no: 2,
                order_detail_id: 3101,
                detail_number: 31,
                completed_quantity: 2,
                sheet_index: 1,
                sheet_ordinal: 2,
              }),
              bathPlacementRow({
                cut_result_id: 501,
                cut_job_id: 31,
                result_no: 1,
                order_detail_id: 3201,
                detail_number: 32,
                completed_quantity: 0,
              }),
            ],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });
    const sql = queries.join('\n');

    expect(sql).toContain("= 'vacuum_table'");
    expect(sql).toContain('cut_result_placement');
    expect(sql).toContain('cut_result_sheet_map');
    expect(sql).toContain('cut_result_label_map_projection');
    expect(sql).toContain('fallback_target_details');
    expect(sql).toContain('completed_whole_order_keys');
    expect(sql).toContain('whole_order_target_details');
    expect(sql).toContain("lower(packet_comment.comment_text) LIKE '%весь%'");
    expect(sql).toContain("regexp_matches(\n        packet_comment.comment_text,\n        '(^|[^0-9])([0-9]{4,})([^0-9]|$)'");
    expect(sql).toContain('1000000000::integer AS completed_quantity');
    expect(sql).toContain('LEAST(SUM(target.completed_quantity), 1000000000::bigint)::integer');
    expect(sql).toContain('candidate_vacuum_results AS (');
    expect(sql).toContain('latest_vacuum_results AS (');
    expect(sql).toContain('SELECT DISTINCT ON (candidate.cut_job_id)');
    expect(sql).toContain('FROM candidate_vacuum_results candidate');
    expect(sql).toContain('(current_result.result_no = r.result_no) AS is_current_result');
    expect(sql).toContain('LEFT JOIN cut_result current_result');
    expect(sql).toContain('LEFT JOIN cut_result_archive_state archive');
    expect(sql).toContain("j.status <> 'archived'");
    expect(sql).toContain('archive.archived_at IS NULL');
    expect(sql).toContain('candidate.is_current_result DESC');
    expect(sql).toContain('candidate.result_created_at DESC');
    expect(sql).toContain('lower(trim(i.order_name)) AS order_key');
    expect(sql).toContain('od.detail_number = item.detail_number');
    expect(sql).toContain('jsonb_array_elements_text(p.comments_json)');
    expect(sql).toContain('item.mdf_relevant');
    expect(sql).toContain('%hdf%');
    expect(sql).toContain('%хдф%');
    expect(sql).toContain('%лдсп%');
    expect(sql).toContain('%ldsp%');
    expect(sql).toContain('%fanera%');
    expect(sql).toContain('%фанера%');
    expect(sql).toContain("item.source <> 'ocr'");
    expect(sql).toContain('item.width_mm::numeric = od.width::numeric');
    expect(sql).toContain("item.source = 'ocr'");
    expect(sql).toContain('ABS(item.width_mm::numeric - od.width::numeric) <= 3');
    expect(result.columns.map((column) => [column.key, column.total])).toEqual([
      ['parsed', 0],
      ['completed', 0],
      ['baths', 1],
      ['baths_ready', 1],
      ['completed_laminated', 0],
      ['baths_laminated', 0],
    ]);
    expect(result.columns[2]?.baths[0]).toMatchObject({
      cutJobId: 31,
      ready: false,
      itemQuantityTotal: 1,
      positionCount: 1,
    });
    expect(result.columns[3]?.baths[0]).toMatchObject({
      cutJobId: 30,
      ready: true,
      itemQuantityTotal: 2,
      positionCount: 1,
      sheets: [
        { cutGroupId: 100, sheetIndex: 0, sheetNumber: 1 },
        { cutGroupId: 100, sheetIndex: 1, sheetNumber: 2 },
      ],
    });
  });

  it('archives a ready bath only when every detail is laminated or later', async () => {
    const database = {
      query: vi.fn(async (text: string) => {
        if (/latest_vacuum_results/i.test(text)) {
          return {
            rows: [
              bathPlacementRow({ laminated_or_later: true }),
              bathPlacementRow({
                order_detail_id: 3102,
                detail_number: 32,
                laminated_or_later: true,
              }),
            ],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository(database as never);

    const result = await repo.listToday({ currentUser: user(), workday: '2026-07-24' });

    expect(result.columns.find((column) => column.key === 'baths_ready')?.baths).toEqual([]);
    expect(result.columns.find((column) => column.key === 'baths_laminated')?.baths)
      .toMatchObject([{ cutJobId: 30, ready: true }]);
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

  it('assigns a cutting sequence number for pending machine packets after item replacement', async () => {
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
          return { rows: [packetRow({ cutting_sequence_no: 13, completion_status: 'pending', thumbs_up: false })] };
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
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:pending-sequence',
        thumbsUp: false,
        completionStatus: 'pending',
      },
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(sql).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(sql).toContain('MAX(cutting_sequence_no)');
    expect(sql).toContain('packet.cutting_sequence_no IS NULL');
    expect(result.packet.cuttingSequenceNo).toBe(13);
  });

  it('stores explicit Telegram cutting sequence numbers under the same sequence lock', async () => {
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
          return { rows: [packetRow({ cutting_sequence_no: 7 })] };
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
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:explicit-sequence',
        cuttingSequenceNo: 7,
      },
      requestId: 'request-cnc-1',
    });

    const sequenceUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets[\s\S]*cutting_sequence_no = \$2::integer/i.test(query.text),
    );
    expect(queries.map((query) => query.text).join('\n')).toContain("pg_advisory_xact_lock(hashtext($1))");
    expect(sequenceUpdate?.params).toEqual([
      '00000000-0000-0000-0000-000000000001',
      7,
      42,
    ]);
    expect(result.packet.cuttingSequenceNo).toBe(7);
  });

  it('replays completed idempotency when Telegram later adds an explicit cutting sequence number', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:completed-explicit-sequence',
      cuttingSequenceNo: 17,
    };
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM command_idempotency_keys/i.test(text)) {
          const inserted = queries.find((query) =>
            /INSERT INTO command_idempotency_keys/i.test(query.text),
          );
          return {
            rows: [{
              request_hash: inserted?.params[4],
              response_json: {
                packet: { ...packetRow(), cuttingSequenceNo: null },
                requestId: 'request-cnc-1',
                applied: false,
                ignoredStaleSourceVersion: false,
              },
              status: 'completed',
            }],
          };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: payloadHashForTest(dto),
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: 17 })] };
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
      dto,
      requestId: 'request-cnc-1',
    });

    const sequenceUpdate = queries.find((query) =>
      /UPDATE cnc_telegram_packets[\s\S]*cutting_sequence_no = \$2::integer/i.test(query.text),
    );
    expect(sequenceUpdate?.params).toEqual([
      '00000000-0000-0000-0000-000000000001',
      17,
      42,
    ]);
    expect(result.applied).toBe(false);
    expect(result.packet.cuttingSequenceNo).toBe(17);
  });

  it('can assign a missing cutting sequence when replaying completed idempotency for a pending packet', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:repo:completed-auto-sequence',
      thumbsUp: false,
      completionStatus: 'pending' as const,
    };
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM command_idempotency_keys/i.test(text)) {
          const inserted = queries.find((query) =>
            /INSERT INTO command_idempotency_keys/i.test(query.text),
          );
          return {
            rows: [{
              request_hash: inserted?.params[4],
              response_json: {
                packet: { cuttingSequenceNo: null },
                requestId: 'request-cnc-1',
                applied: true,
                ignoredStaleSourceVersion: false,
              },
              status: 'completed',
            }],
          };
        }
        if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
          return {
            rows: [{
              packet_id: '00000000-0000-0000-0000-000000000001',
              source_version: 1,
              payload_hash: payloadHashForTest(dto),
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              cutting_sequence_no: 21,
              completion_status: 'pending',
              thumbs_up: false,
            })],
          };
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
      dto,
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(sql).toContain('MAX(cutting_sequence_no)');
    expect(result.applied).toBe(false);
    expect(result.packet.cuttingSequenceNo).toBe(21);
  });

  it('can assign a missing cutting sequence on stale source-version replays', async () => {
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
              source_version: 5,
              payload_hash: 'sha256:old',
            }],
          };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return { rows: [packetRow({ cutting_sequence_no: 14, source_version: 5 })] };
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
      dto: {
        ...ingestDto(),
        idempotencyKey: 'cnc:test:repo:stale-sequence',
        source: { ...ingestDto().source, version: 4 },
        thumbsUp: false,
        completionStatus: 'pending',
      },
      requestId: 'request-cnc-1',
    });

    const sql = queries.map((query) => query.text).join('\n');
    expect(result.ignoredStaleSourceVersion).toBe(true);
    expect(sql).toContain('MAX(cutting_sequence_no)');
    expect(result.packet.cuttingSequenceNo).toBe(14);
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

  it('uses OCR tolerance when resolving ERP detail size', async () => {
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
        idempotencyKey: 'cnc:test:repo:ocr-size-tolerance',
        items: [
          {
            sourceItemKey: '2690:none:502x350',
            orderName: '2690',
            detailNumber: null,
            widthMm: 502,
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
  });

  it('does not use size tolerance for non-OCR ERP detail resolution', async () => {
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
        idempotencyKey: 'cnc:test:repo:vector-size-exact',
        items: [
          {
            sourceItemKey: '2690:none:502x350',
            orderName: '2690',
            detailNumber: null,
            widthMm: 502,
            heightMm: 350,
            quantity: 1,
            source: 'vector' as const,
            confidence: 1,
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

  it('matches identical duplicate ERP detail rows as one logical detail', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM orders o\s+JOIN order_details od/i.test(text)) {
          return {
            rows: [
              {
                order_key: '2665',
                order_id: 11409,
                detail_id: 61445,
                detail_number: 17,
                width: 531,
                height: 1965,
              },
              {
                order_key: '2665',
                order_id: 11409,
                detail_id: 62381,
                detail_number: 17,
                width: 531,
                height: 1965,
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
        idempotencyKey: 'cnc:test:repo:logical-duplicate-detail',
        items: [
          {
            sourceItemKey: '2665:17:1965x531',
            orderName: '2665',
            detailNumber: 17,
            widthMm: 1965,
            heightMm: 531,
            quantity: 2,
            source: 'svg' as const,
            confidence: 0.99,
            matchStatus: 'unmatched' as const,
          },
        ],
      },
      requestId: 'request-cnc-1',
    });

    const itemInsert = queries.find((query) =>
      /INSERT INTO cnc_telegram_packet_items/i.test(query.text),
    );
    expect(itemInsert?.params[9]).toBe(11409);
    expect(itemInsert?.params[10]).toBe(62381);
    expect(itemInsert?.params[11]).toBe('matched');
  });

  it('creates a completed cut result command when importing a valid SVG layout', async () => {
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
                detail_id: 3101,
                detail_number: 31,
                width: 497,
                height: 477,
              },
            ],
          };
        }
        if (/SELECT od\.detail_id, od\.order_id/i.test(text)) {
          return {
            rows: [
              {
                detail_id: 3101,
                order_id: 2689,
                order_name: '2689',
                order_delete_flag: false,
                detail_number: 31,
                detail_name: 'Detail 31',
                height: 477,
                width: 497,
                order_quantity: 4,
                area: 0.237,
                material_id: 10,
                sheet_material_type_id: 77,
                sheet_material_width_mm: 2070,
                sheet_material_height_mm: 2800,
                material_name: 'MDF 18',
                milling_type_id: null,
                milling_type_name: null,
                edge_type_id: null,
                edge_type_name: null,
                film_id: 88,
                film_name: 'White',
                priority: null,
                production_status_id: null,
                production_status_name: null,
                joint_order_id: null,
                note: null,
                link_cutting_file: null,
                link_cutting_image_file: null,
                link_cad_file: null,
                link_pdf_file: null,
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
        if (/SELECT svg_cut_job_id, svg_cut_result_id, svg_cut_import_status/i.test(text)) {
          return { rows: [{ svg_cut_job_id: null, svg_cut_result_id: null, svg_cut_import_status: 'none' }] };
        }
        if (/INSERT INTO cut_job\s*\(/i.test(text)) {
          return { rows: [{ cut_job_id: 700 }] };
        }
        if (/INSERT INTO cut_group\s*\(/i.test(text)) {
          return { rows: [{ cut_group_id: 701 }] };
        }
        if (/INSERT INTO cut_job_item\s*\(/i.test(text)) {
          return { rows: [{ cut_job_item_id: 702 }] };
        }
        if (/INSERT INTO cut_group_sheet\s*\(/i.test(text)) {
          return { rows: [{ cut_group_sheet_id: 703 }] };
        }
        if (/INSERT INTO cut_result\s*\(/i.test(text)) {
          return { rows: [{ cut_result_id: 704 }] };
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
        idempotencyKey: 'cnc:test:repo:svg-cut-ledger',
        items: [
          {
            sourceItemKey: '2689:31:497x477',
            orderName: '2689',
            detailNumber: 31,
            widthMm: 497,
            heightMm: 477,
            quantity: 1,
            source: 'vector' as const,
            confidence: 1,
            matchOrderId: 2689,
            matchDetailId: 3101,
            matchStatus: 'matched' as const,
          },
        ],
        cutLayout: {
          status: 'valid' as const,
          reasons: [],
          sheet: { widthMm: 2070, heightMm: 2800 },
          partContourCount: 1,
          acceptedItemCount: 1,
          items: [
            {
              orderName: '2689',
              detailNumber: 31,
              widthMm: 497,
              heightMm: 477,
              quantity: 1,
              confidence: 1,
              sourceElementId: 'PartContour-1',
              xMm: 10,
              yMm: 20,
              placedWidthMm: 497,
              placedHeightMm: 477,
              rotated: false,
            },
          ],
        },
      },
      requestId: 'request-cnc-1',
    });

    const commandInsertIndex = queries.findIndex((query) =>
      /INSERT INTO cut_result_command/i.test(query.text) && /'manual_save'/.test(query.text),
    );
    const resultInsertIndex = queries.findIndex((query) => /INSERT INTO cut_result\s*\(/i.test(query.text));
    const commandComplete = queries.find((query) => /UPDATE cut_result_command/i.test(query.text));
    const commandInsert = queries[commandInsertIndex];
    const resultInsert = queries[resultInsertIndex];

    expect(commandInsertIndex).toBeGreaterThan(-1);
    expect(resultInsertIndex).toBeGreaterThan(commandInsertIndex);
    expect(resultInsert?.text).toContain('command_id, command_payload_hash, request_hash');
    expect(commandInsert?.params[1]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(resultInsert?.params[1]).toBe(commandInsert?.params[1]);
    expect(resultInsert?.params[2]).toBe(commandInsert?.params[2]);
    expect(JSON.parse(String(resultInsert?.params[4]))).toMatchObject({ unplaced: [] });
    expect(commandComplete?.params).toEqual([700, commandInsert?.params[1], 704]);
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

  it('marks only fully cut matched details when a packet first becomes completed and automation is enabled', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    let auditIndex = 0;
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
              payload_hash: 'sha256:previous',
              completion_status: 'pending',
              thumbs_up: false,
            }],
          };
        }
        if (/FROM unnest\(\$1::bigint\[\], \$2::bigint\[\]\)/i.test(text)) {
          return { rows: [] };
        }
        if (/FROM cnc_telegram_packets p/i.test(text)) {
          return {
            rows: [packetRow({
              source_version: 2,
              completion_status: 'completed',
              thumbs_up: true,
              comments_json: [],
            })],
          };
        }
        if (/FROM app_settings/i.test(text)) {
          return { rows: [{ is_active: true, value_json: { value: true } }] };
        }
        if (/FROM production_statuses/i.test(text) && /lower\(trim\(production_status_name\)\) = 'распилен'/i.test(text)) {
          return {
            rows: [{
              production_status_id: 4,
              production_status_name: 'Распилен',
              production_status_code: 'cut',
              sort_order: 40,
            }],
          };
        }
        if (/FROM production_statuses/i.test(text) && /production_status_id = ANY/i.test(text)) {
          return { rows: [{ production_status_id: 2, sort_order: 20 }] };
        }
        if (/WITH completed_quantities AS/i.test(text)) {
          return { rows: [{ order_id: 2689, detail_id: 3101 }] };
        }
        if (/FROM orders\s+WHERE order_id = ANY/i.test(text)) {
          return {
            rows: [{
              order_id: 2689,
              order_name: '2689',
              client_id: 77,
              version: 8,
              production_status_id: 2,
              production_status_from_details_enabled: true,
            }],
          };
        }
        if (/FROM order_details details/i.test(text) && /FOR UPDATE OF details/i.test(text)) {
          return {
            rows: [{
              order_id: 2689,
              detail_id: 3101,
              production_status_id: 2,
              production_status_sort_order: 20,
            }],
          };
        }
        if (/UPDATE order_details/i.test(text) && /RETURNING order_id, detail_id/i.test(text)) {
          return { rows: [{ order_id: 2689, detail_id: 3101 }] };
        }
        if (/UPDATE orders/i.test(text) && /version = version \+ 1/i.test(text)) {
          return {
            rows: [{
              order_id: 2689,
              order_name: '2689',
              client_id: 77,
              version: 9,
              production_status_id: 4,
              production_status_from_details_enabled: true,
            }],
          };
        }
        if (/INSERT INTO audit_log/i.test(text)) {
          auditIndex += 1;
          return { rows: [{ audit_id: `audit-${auditIndex}` }] };
        }
        return { rows: [] };
      }),
    };
    const database = {
      transaction: vi.fn((handler) => handler(tx)),
    };
    const repo = new PgCncTelegramRepository(database as never);
    const dto = {
      ...ingestDto(),
      idempotencyKey: 'cnc:test:auto-cut-status',
      source: { ...ingestDto().source, version: 2 },
      cuttingSequenceNo: 12,
      completionStatus: 'completed' as const,
      comments: [],
    };

    await repo.ingest({ currentUser: user(), dto, requestId: 'request-cnc-auto-cut' });

    const targetQuery = queries.find((query) => /WITH completed_quantities AS/i.test(query.text));
    const orderLockIndex = queries.findIndex((query) =>
      /FROM orders\s+WHERE order_id = ANY/i.test(query.text),
    );
    const targetQueryIndex = queries.findIndex((query) => /WITH completed_quantities AS/i.test(query.text));
    const detailLockIndex = queries.findIndex((query) => /FOR UPDATE OF details/i.test(query.text));
    const currentStatusLockIndex = queries.findIndex((query) =>
      /FROM production_statuses/i.test(query.text)
      && /production_status_id = ANY/i.test(query.text),
    );
    const detailUpdate = queries.find((query) =>
      /UPDATE order_details/i.test(query.text) && /RETURNING order_id, detail_id/i.test(query.text),
    );
    const autoCutOutbox = queries.find((query) =>
      /INSERT INTO outbox_events/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_applied',
    );

    expect(targetQuery?.params).toEqual([[3101], [], [2689]]);
    expect(targetQuery?.text).toContain('SUM(GREATEST(item.quantity, 0))');
    expect(targetQuery?.text).toContain('completed.completed_quantity, 0) >= GREATEST');
    expect(orderLockIndex).toBeGreaterThan(-1);
    expect(targetQueryIndex).toBeGreaterThan(orderLockIndex);
    expect(currentStatusLockIndex).toBeGreaterThan(detailLockIndex);
    expect(queries[currentStatusLockIndex]?.text).toContain('FOR SHARE');
    expect(detailUpdate?.params).toEqual([4, [3101]]);
    expect(queries.some((query) =>
      /SELECT recalc_order_production_status\(\$1\)/i.test(query.text)
      && query.params[0] === 2689,
    )).toBe(true);
    expect(autoCutOutbox?.params[4]).toBe('cnc:test:auto-cut-status:auto-cut-status');
  });

  it('does not run auto-cut status changes when the setting is disabled', async () => {
    const queries = await runAutoCutIngest({ settingRows: [] });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it.each([
    { is_active: false, value_json: { value: true } },
    { is_active: true, value_json: { value: false } },
    { is_active: true, value_json: 'true' },
  ])('rejects inactive or malformed auto-cut setting %#', async (settingRow) => {
    const queries = await runAutoCutIngest({ settingRows: [settingRow] });

    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('accepts the legacy raw-boolean setting representation', async () => {
    const queries = await runAutoCutIngest({
      settingRows: [{ is_active: true, value_json: true }],
    });

    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('reconciles an already-completed packet revision without rewriting an already-cut detail', async () => {
    const queries = await runAutoCutIngest({
      previousCompletionStatus: 'completed',
      previousThumbsUp: true,
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: 4,
        production_status_sort_order: 40,
      }],
    });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /pg_advisory_xact_lock/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('applies auto-cut status when a new packet is initially ingested as completed', async () => {
    const queries = await runAutoCutIngest({ previousExists: false });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('does not run auto-cut status changes while the packet remains pending', async () => {
    const queries = await runAutoCutIngest({
      currentCompletionStatus: 'pending',
      currentThumbsUp: false,
    });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('runs auto-cut status changes for a thumbs-up-only completion transition', async () => {
    const queries = await runAutoCutIngest({
      currentCompletionStatus: 'pending',
      currentThumbsUp: true,
    });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('stops auto-cut status changes when the target production status is unavailable', async () => {
    const queries = await runAutoCutIngest({ statusRows: [] });

    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(true);
    expect(queries.some((query) =>
      /pg_advisory_xact_lock/i.test(query.text)
      && query.params[0] === 'status_automation.cnc_mark_cut_details',
    )).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('resolves the target production status by stable code when its name differs', async () => {
    const queries = await runAutoCutIngest({
      statusRows: [{
        production_status_id: 4,
        production_status_name: 'Распил завершён',
        production_status_code: 'cut',
        sort_order: 40,
      }],
    });

    const targetStatusQuery = queries.find((query) =>
      /FROM production_statuses\s+WHERE/i.test(query.text),
    );
    expect(targetStatusQuery?.text).toContain('FOR SHARE');
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
  });

  it('stops before loading a status when the completed packet has no matched details', async () => {
    const queries = await runAutoCutIngest({ currentItemMatched: false });

    expect(queries.some((query) => /FROM app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('waits for the cumulative completed quantity before marking a detail as cut', async () => {
    const queries = await runAutoCutIngest({ targetRows: [] });

    expect(queries.some((query) => /WITH completed_quantities AS/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('does not downgrade a detail whose production status is later than «Распилен»', async () => {
    const queries = await runAutoCutIngest({
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: 7,
        production_status_sort_order: 70,
      }],
    });

    expect(queries.some((query) => /FOR UPDATE OF details/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('does not rewrite a detail already in the target production status', async () => {
    const queries = await runAutoCutIngest({
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: 4,
        production_status_sort_order: 40,
      }],
    });

    expect(queries.some((query) => /FOR UPDATE OF details/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('stops after the parent lock when all candidate orders disappeared', async () => {
    const queries = await runAutoCutIngest({ orderRows: [] });

    expect(queries.some((query) => /FROM orders\s+WHERE order_id = ANY/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /WITH completed_quantities AS/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('updates eligible details without recalculating an order in manual production-status mode', async () => {
    const queries = await runAutoCutIngest({
      orderRows: [{
        order_id: 2689,
        order_name: '2689',
        client_id: 77,
        version: 8,
        production_status_id: 2,
        production_status_from_details_enabled: false,
      }],
      detailRows: [{
        order_id: 2689,
        detail_id: 3101,
        production_status_id: null,
        production_status_sort_order: null,
      }],
    });

    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /recalc_order_production_status/i.test(query.text))).toBe(false);
    expect(queries.some((query) =>
      /INSERT INTO outbox_events/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_applied',
    )).toBe(true);
  });

  it('passes an explicitly named whole order to the all-details target branch', async () => {
    const queries = await runAutoCutIngest({ comments: ['2689 — весь заказ'] });
    const orderLock = queries.find((query) =>
      /FROM orders\s+WHERE order_id = ANY/i.test(query.text),
    );
    const targetQuery = queries.find((query) => /WITH completed_quantities AS/i.test(query.text));

    expect(orderLock?.params).toEqual([[2689]]);
    expect(orderLock?.text).not.toContain('lower(trim(order_name))');
    expect(targetQuery?.params).toEqual([[3101], [2689], [2689]]);
    expect(targetQuery?.text).toContain('OR details.order_id = ANY($2::bigint[])');
  });

  it('enables auto-cut status and backfills every existing completed card atomically', async () => {
    const { result, queries } = await runAutoCutConfigure();
    const lockIndex = queries.findIndex((query) => /pg_advisory_xact_lock/i.test(query.text));
    const settingReadIndex = queries.findIndex((query) => /FROM app_settings/i.test(query.text));
    const settingWriteIndex = queries.findIndex((query) => /INSERT INTO app_settings/i.test(query.text));
    const backfillIndex = queries.findIndex((query) => /COUNT\(DISTINCT packet.packet_id\)/i.test(query.text));
    const targetQuery = queries.find((query) => /WITH completed_quantities AS/i.test(query.text));

    expect(result).toEqual({
      settingEnabled: true,
      requestId: 'request-auto-cut-configure',
      auditId: 'audit-configure',
      completedPacketCount: 3,
      matchedDetailCount: 1,
      wholeOrderCount: 1,
      changedOrderCount: 1,
      changedDetailCount: 1,
    });
    expect(lockIndex).toBeGreaterThan(-1);
    expect(settingReadIndex).toBeGreaterThan(lockIndex);
    expect(settingWriteIndex).toBeGreaterThan(settingReadIndex);
    expect(backfillIndex).toBeGreaterThan(settingWriteIndex);
    expect(targetQuery?.params).toEqual([[3101], [2689], [2689]]);
    const configureAudit = queries.find((query) =>
      /INSERT INTO audit_log/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_configured',
    );
    const configureOutbox = queries.find((query) =>
      /INSERT INTO outbox_events/i.test(query.text)
      && query.params[0] === 'cnc.telegram_packet.auto_cut_status_configured',
    );
    const expectedCounts = {
      completedPacketCount: 3,
      matchedDetailCount: 1,
      wholeOrderCount: 1,
      changedOrderCount: 1,
      changedDetailCount: 1,
    };
    expect(JSON.parse(String(configureAudit?.params[22]))).toMatchObject(expectedCounts);
    expect(JSON.parse(String(configureOutbox?.params[3]))).toMatchObject(expectedCounts);
    expect(queries.some((query) =>
      /UPDATE command_idempotency_keys/i.test(query.text)
      && query.params[0] === 'cnc-auto-cut-status:test-configure',
    )).toBe(true);
  });

  it('disables auto-cut status without running a backfill', async () => {
    const { result, queries } = await runAutoCutConfigure({ enabled: false });

    expect(result).toMatchObject({
      settingEnabled: false,
      completedPacketCount: 0,
      matchedDetailCount: 0,
      changedDetailCount: 0,
    });
    expect(queries.some((query) => /pg_advisory_xact_lock/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /INSERT INTO app_settings/i.test(query.text))).toBe(true);
    expect(queries.some((query) => /FROM production_statuses\s+WHERE/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /COUNT\(DISTINCT packet.packet_id\)/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('replays completed auto-cut configuration without repeating the backfill', async () => {
    const replay = {
      settingEnabled: true,
      requestId: 'request-original',
      auditId: 'audit-original',
      completedPacketCount: 3,
      matchedDetailCount: 1,
      wholeOrderCount: 1,
      changedOrderCount: 1,
      changedDetailCount: 1,
    };
    const { result, queries } = await runAutoCutConfigure({ replay });

    expect(result).toEqual(replay);
    expect(queries.some((query) => /pg_advisory_xact_lock/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /INSERT INTO app_settings/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('does not enable auto-cut status when «Распилен» is unavailable', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (/INSERT INTO command_idempotency_keys/i.test(text)) {
          return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
        }
        if (/FROM app_settings/i.test(text)) return { rows: [] };
        if (/FROM production_statuses/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    const repo = new PgCncTelegramRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repo.configureAutoCutStatus({
      currentUser: user(),
      enabled: true,
      idempotencyKey: 'cnc-auto-cut-status:test-missing',
      requestId: 'request-missing',
    })).rejects.toMatchObject({ code: 'CNC_AUTO_CUT_STATUS_NOT_FOUND', statusCode: 409 });

    expect(queries.some((query) => /INSERT INTO app_settings/i.test(query.text))).toBe(false);
    expect(queries.some((query) => /UPDATE order_details/i.test(query.text))).toBe(false);
  });

  it('resolves explicit and single-order «весь заказ» comments without guessing across orders', () => {
    const item = (orderName: string) => ({ orderName }) as never;

    expect(cncWholeOrderKeys({
      comments: ['11380 — весь заказ'],
      items: [item('11380'), item('11770')],
    })).toEqual(['11380']);
    expect(cncWholeOrderKeys({
      comments: ['весь заказ'],
      items: [item('11380')],
    })).toEqual(['11380']);
    expect(cncWholeOrderKeys({
      comments: ['весь заказ'],
      items: [item('11380'), item('11770')],
    })).toEqual([]);
    expect(cncWholeOrderKeys({
      comments: ['12345 — весь заказ'],
      items: [item('1234'), item('12345')],
    })).toEqual(['12345']);
    expect(cncWholeOrderKeys({
      comments: ['MDF-12 — весь заказ'],
      items: [item('MDF-1'), item('MDF-12')],
    })).toEqual(['mdf-12']);
    expect(cncWholeOrderKeys({
      comments: ['MDF-1-2 — весь заказ'],
      items: [item('MDF-1'), item('MDF-1-2')],
    })).toEqual(['mdf-1-2']);
    expect(cncWholeOrderKeys({
      comments: ['MDF-1-2 и MDF-1 — весь заказ'],
      items: [item('MDF-1'), item('MDF-1-2')],
    })).toEqual(['mdf-1-2', 'mdf-1']);
    expect(cncWholeOrderKeys({
      comments: ['телефон 77001234567 — весь заказ'],
      items: [item('1234'), item('12345')],
    })).toEqual([]);
  });

  it('resolves whole-order comments only to one stable matched order id', () => {
    const item = (
      orderName: string,
      matchOrderId: number | null,
      matchStatus: 'matched' | 'conflict' = 'matched',
    ) => ({
      orderName,
      matchOrderId,
      matchStatus,
    }) as never;

    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('1234', 100), item('12345', 200), item('12345', 200)],
    })).toEqual([200]);
    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('12345', 200), item('12345', 201)],
    })).toEqual([]);
    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('12345', null)],
    })).toEqual([]);
    expect(cncWholeOrderIds({
      comments: ['12345 — весь заказ'],
      items: [item('12345', 200, 'conflict')],
    })).toEqual([]);
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

function payloadHashForTest(dto: ReturnType<typeof ingestDto> & { cuttingSequenceNo?: number }) {
  const { idempotencyKey: _idempotencyKey, cuttingSequenceNo: _cuttingSequenceNo, ...payload } = dto;
  return `sha256:${createHash('sha256').update(stableStringifyForTest(payload)).digest('hex')}`;
}

function stableStringifyForTest(value: unknown): string {
  if (value === undefined) return '"__undefined__"';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringifyForTest).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringifyForTest(record[key])}`,
  ).join(',')}}`;
}

function packetRow(overrides: Partial<ReturnType<typeof packetRowBase>> = {}) {
  return { ...packetRowBase(), ...overrides };
}

function packetRowBase() {
  return {
    packet_id: '00000000-0000-0000-0000-000000000001',
    external_packet_key: 'chat:-100:message:10',
    cutting_sequence_no: 12,
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
    cut_layout_json: null,
    svg_cut_job_id: null,
    svg_cut_result_id: null,
    svg_cut_result_no: null,
    svg_cut_import_status: null,
    svg_cut_import_note: null,
    updated_at: '2026-07-24T08:00:10.000Z',
    packet_item_id: '00000000-0000-0000-0000-000000000002',
    source_item_key: '2689:31:497x477',
    order_name: '2689',
    item_order_id: 2689,
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
    laminated_or_later: false,
  };
}

interface AutoCutIngestOptions {
  previousExists?: boolean;
  previousCompletionStatus?: 'pending' | 'completed' | 'failed';
  previousThumbsUp?: boolean;
  currentCompletionStatus?: 'pending' | 'completed' | 'failed';
  currentThumbsUp?: boolean;
  currentItemMatched?: boolean;
  comments?: string[];
  settingRows?: Array<{ is_active: boolean; value_json: unknown }>;
  statusRows?: Array<{
    production_status_id: number;
    production_status_name: string;
    production_status_code: string | null;
    sort_order: number;
  }>;
  targetRows?: Array<{ order_id: number; detail_id: number }>;
  orderRows?: Array<{
    order_id: number;
    order_name: string;
    client_id: number | null;
    version: number;
    production_status_id: number | null;
    production_status_from_details_enabled: boolean;
  }>;
  detailRows?: Array<{
    order_id: number;
    detail_id: number;
    production_status_id: number | null;
    production_status_sort_order: number | null;
  }>;
}

async function runAutoCutIngest(options: AutoCutIngestOptions = {}) {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  let auditIndex = 0;
  const targetRows = options.targetRows ?? [{ order_id: 2689, detail_id: 3101 }];
  const orderRows = options.orderRows ?? [{
    order_id: 2689,
    order_name: '2689',
    client_id: 77,
    version: 8,
    production_status_id: 2,
    production_status_from_details_enabled: true,
  }];
  const detailRows = options.detailRows ?? [{
    order_id: 2689,
    detail_id: 3101,
    production_status_id: 2,
    production_status_sort_order: 20,
  }];
  const tx = {
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      queries.push({ text, params });
      if (/INSERT INTO command_idempotency_keys/i.test(text)) {
        return { rows: [{ request_hash: 'hash', response_json: null, status: 'processing' }] };
      }
      if (/INSERT INTO cnc_telegram_packets/i.test(text)) {
        return { rows: [{ packet_id: '00000000-0000-0000-0000-000000000001' }] };
      }
      if (/FROM cnc_telegram_packets\s+WHERE external_packet_key/i.test(text)) {
        return {
          rows: options.previousExists === false ? [] : [{
            packet_id: '00000000-0000-0000-0000-000000000001',
            source_version: 1,
            payload_hash: 'sha256:previous',
            completion_status: options.previousCompletionStatus ?? 'pending',
            thumbs_up: options.previousThumbsUp ?? false,
          }],
        };
      }
      if (/FROM unnest\(\$1::bigint\[\], \$2::bigint\[\]\)/i.test(text)) {
        return { rows: [] };
      }
      if (/FROM cnc_telegram_packets p/i.test(text)) {
        return {
          rows: [packetRow({
            source_version: 2,
            completion_status: options.currentCompletionStatus ?? 'completed',
            thumbs_up: options.currentThumbsUp ?? true,
            comments_json: options.comments ?? [],
            ...(options.currentItemMatched === false
              ? { match_order_id: null, match_detail_id: null, match_status: 'unmatched' }
              : {}),
          })],
        };
      }
      if (/FROM app_settings/i.test(text)) {
        return {
          rows: options.settingRows ?? [{ is_active: true, value_json: { value: true } }],
        };
      }
      if (/FROM production_statuses/i.test(text)
        && /lower\(trim\(production_status_name\)\) = 'распилен'/i.test(text)) {
        return {
          rows: options.statusRows ?? [{
            production_status_id: 4,
            production_status_name: 'Распилен',
            production_status_code: 'cut',
            sort_order: 40,
          }],
        };
      }
      if (/FROM production_statuses/i.test(text) && /production_status_id = ANY/i.test(text)) {
        const requestedStatusIds = new Set((params[0] as number[]) ?? []);
        return {
          rows: detailRows
            .filter((row) => row.production_status_id !== null
              && requestedStatusIds.has(row.production_status_id))
            .map((row) => ({
              production_status_id: row.production_status_id,
              sort_order: row.production_status_sort_order,
            })),
        };
      }
      if (/WITH completed_quantities AS/i.test(text)) return { rows: targetRows };
      if (/FROM orders\s+WHERE order_id = ANY/i.test(text)) return { rows: orderRows };
      if (/FROM order_details details/i.test(text) && /FOR UPDATE OF details/i.test(text)) {
        return { rows: detailRows };
      }
      if (/UPDATE order_details/i.test(text) && /RETURNING order_id, detail_id/i.test(text)) {
        return { rows: targetRows };
      }
      if (/UPDATE orders/i.test(text) && /version = version \+ 1/i.test(text)) {
        return {
          rows: orderRows.map((row) => ({
            ...row,
            version: row.version + 1,
            production_status_id: 4,
          })),
        };
      }
      if (/INSERT INTO audit_log/i.test(text)) {
        auditIndex += 1;
        return { rows: [{ audit_id: `audit-${auditIndex}` }] };
      }
      return { rows: [] };
    }),
  };
  const database = { transaction: vi.fn((handler) => handler(tx)) };
  const repo = new PgCncTelegramRepository(database as never);
  const dto = {
    ...ingestDto(),
    idempotencyKey: 'cnc:test:auto-cut-status-guard',
    source: { ...ingestDto().source, version: 2 },
    cuttingSequenceNo: 12,
    completionStatus: options.currentCompletionStatus ?? 'completed',
    thumbsUp: options.currentThumbsUp ?? true,
    comments: options.comments ?? [],
  };

  await repo.ingest({ currentUser: user(), dto, requestId: 'request-cnc-auto-cut-guard' });
  return queries;
}

interface AutoCutConfigureOptions {
  enabled?: boolean;
  replay?: {
    settingEnabled: boolean;
    requestId: string;
    auditId: string;
    completedPacketCount: number;
    matchedDetailCount: number;
    wholeOrderCount: number;
    changedOrderCount: number;
    changedDetailCount: number;
  };
}

async function runAutoCutConfigure(options: AutoCutConfigureOptions = {}) {
  const enabled = options.enabled ?? true;
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const requestHash = createHash('sha256').update(stableStringifyForTest({
    actorUserId: '42',
    commandName: 'cnc.telegram_packet.auto_cut_status.configure',
    enabled,
  })).digest('hex');
  const tx = {
    query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
      queries.push({ text, params });
      if (/INSERT INTO command_idempotency_keys/i.test(text)) {
        return options.replay
          ? { rows: [] }
          : { rows: [{ request_hash: requestHash, response_json: null, status: 'processing' }] };
      }
      if (/FROM command_idempotency_keys/i.test(text)) {
        return {
          rows: [{
            request_hash: requestHash,
            response_json: options.replay ?? null,
            status: options.replay ? 'completed' : 'processing',
          }],
        };
      }
      if (/FROM app_settings/i.test(text)) {
        return { rows: [{ is_active: true, value_json: { value: false } }] };
      }
      if (/FROM production_statuses/i.test(text) && /production_status_id = ANY/i.test(text)) {
        return { rows: [{ production_status_id: 2, sort_order: 20 }] };
      }
      if (/FROM production_statuses/i.test(text)) {
        return {
          rows: [{
            production_status_id: 4,
            production_status_name: 'Распилен',
            production_status_code: 'cut',
            sort_order: 40,
          }],
        };
      }
      if (/COUNT\(DISTINCT packet.packet_id\)/i.test(text)) {
        return {
          rows: [{
            completed_packet_count: 3,
            matched_detail_ids: [3101],
            matched_order_ids: [2689],
          }],
        };
      }
      if (/jsonb_array_elements_text/i.test(text)) {
        return {
          rows: [{
            comments_json: ['2689 — весь заказ'],
            items_json: [{ orderName: '2689', matchOrderId: 2689 }],
          }],
        };
      }
      if (/FROM orders\s+WHERE order_id = ANY/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            order_name: '2689',
            client_id: 77,
            version: 8,
            production_status_id: 2,
            production_status_from_details_enabled: true,
          }],
        };
      }
      if (/WITH completed_quantities AS/i.test(text)) {
        return { rows: [{ order_id: 2689, detail_id: 3101 }] };
      }
      if (/FROM order_details details/i.test(text) && /FOR UPDATE OF details/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            detail_id: 3101,
            production_status_id: 2,
            production_status_sort_order: 20,
          }],
        };
      }
      if (/UPDATE order_details/i.test(text) && /RETURNING order_id, detail_id/i.test(text)) {
        return { rows: [{ order_id: 2689, detail_id: 3101 }] };
      }
      if (/UPDATE orders/i.test(text) && /version = version \+ 1/i.test(text)) {
        return {
          rows: [{
            order_id: 2689,
            order_name: '2689',
            client_id: 77,
            version: 9,
            production_status_id: 4,
            production_status_from_details_enabled: true,
          }],
        };
      }
      if (/INSERT INTO audit_log/i.test(text)) {
        return { rows: [{ audit_id: 'audit-configure' }] };
      }
      return { rows: [] };
    }),
  };
  const repo = new PgCncTelegramRepository({
    transaction: vi.fn((handler) => handler(tx)),
  } as never);
  const result = await repo.configureAutoCutStatus({
    currentUser: user(),
    enabled,
    idempotencyKey: 'cnc-auto-cut-status:test-configure',
    requestId: 'request-auto-cut-configure',
  });
  return { result, queries };
}

function bathPlacementRow(overrides: Record<string, unknown> = {}) {
  return {
    cut_result_id: 500,
    cut_job_id: 30,
    result_no: 2,
    revision_no: 1,
    result_created_at: '2026-07-24T09:00:00.000Z',
    cut_job_name: 'Ванна 2689',
    order_id: 2689,
    order_detail_id: 3101,
    order_name: '2689',
    detail_number: 31,
    width_mm: 497,
    height_mm: 477,
    completed_quantity: 2,
    laminated_or_later: false,
    cut_group_id: 100,
    variant: 'auto',
    sheet_index: 0,
    sheet_ordinal: 1,
    sheet_width_mm: 2070,
    sheet_height_mm: 2800,
    ...overrides,
  };
}
