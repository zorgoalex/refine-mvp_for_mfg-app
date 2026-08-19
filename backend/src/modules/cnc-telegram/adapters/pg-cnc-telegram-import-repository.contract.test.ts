import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { canonicalLayoutFingerprint } from './pg-cnc-telegram-repository';
import {
  PgCncTelegramImportRepository,
  assertTerminalItemLeaseReplay,
  inferTelegramImportSelectedOrderIds,
  telegramImportItemsFromLayout,
} from './pg-cnc-telegram-import-repository';
import { parseImportComplete } from '../dto/cnc-telegram-import.dto';

const source = readFileSync(new URL('./pg-cnc-telegram-import-repository.ts', import.meta.url), 'utf8');
const dto = readFileSync(new URL('../dto/cnc-telegram-import.dto.ts', import.meta.url), 'utf8');

describe('explicit Telegram import backend contracts', () => {
  it('fences every worker mutation and exposes persisted source payload on claims', () => {
    expect(source).toContain('assertCurrentWorkerSessionInTransaction');
    expect(source).toContain('lease_generation');
    expect(source).toContain('source_set_fingerprint');
    expect(source).toContain('itemDto(full');
    expect(source).toContain("status IN ('pending','processing')");
  });

  it('reconciles duplicates before completion and permits explicit reconfirmation', () => {
    expect(source).toContain("status='confirmation_required'");
    expect(source).toContain("SET status='draft'");
    expect(source).toContain("kind: 'intentional_copy'");
    expect(source).toContain("same_layout");
    expect(dto).toContain('duplicateAcknowledgements');
    expect(dto).toContain('sourceFiles');
    expect(source).toContain('cnc.telegram_import.duplicate_acknowledged');
  });

  it('accepts terminal replay only from the exact original item lease', () => {
    const row = {
      source_chat_id: '-1001', lease_token: 't'.repeat(32), lease_generation: 4,
      lease_worker_instance_id: '00000000-0000-4000-8000-000000000001',
    };
    const replay = {
      itemLeaseToken: 't'.repeat(32), itemLeaseGeneration: 4,
      itemLeaseOwner: '00000000-0000-4000-8000-000000000001',
    };
    expect(() => assertTerminalItemLeaseReplay(row, replay, '-1001')).not.toThrow();
    expect(() => assertTerminalItemLeaseReplay(row, { ...replay, itemLeaseGeneration: 3 }, '-1001')).toThrow('original item lease');
    expect(() => assertTerminalItemLeaseReplay(row, replay, '-1002')).toThrow('original item lease');
  });

  it('normalizes PostgreSQL DATE values in the scan DTO', async () => {
    const row = {
      scan_id: 'scan-1', source_chat_id: '-1001', requested_by: 'user-1',
      date_from: new Date(2026, 7, 17), date_to: new Date(2026, 7, 19),
      business_timezone: 'Asia/Almaty', status: 'pending',
      created_at: new Date(2026, 7, 17, 9), completed_at: null,
      days_scanned: 1, messages_scanned: 12, candidates_found: 2,
      warnings_count: 0, truncated: false, error_message: null,
      lease_token: null, lease_generation: 0, worker_instance_id: null,
    };
    const tx = { query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
    const database = {
      transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx),
    } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, {} as never);

    const scan = await repository.getScan({
      currentUser: { id: 'user-1', username: 'tester', role: 'manager', roleId: 1, permissions: [] },
      scanId: 'scan-1',
    });

    expect(scan.dateFrom).toBe('2026-08-17');
    expect(scan.dateTo).toBe('2026-08-19');
    expect(scan.progress.daysTotal).toBe(3);

    row.date_from = new Date(Number.NaN);
    await expect(repository.getScan({
      currentUser: { id: 'user-1', username: 'tester', role: 'manager', roleId: 1, permissions: [] },
      scanId: 'scan-1',
    })).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_CNC_TELEGRAM_IMPORT_RANGE' });
  });

  it('normalizes PostgreSQL DATE workdays in the public candidate DTO', async () => {
    const candidate = {
      candidate_id: 'candidate-1', scan_id: 'scan-1', source_chat_id: '-1001',
      source_message_id: 42, workday: new Date(2026, 7, 18),
      source_created_at: null, source_updated_at: null, source_thread_id: null,
      svg_message_id: 42, gcode_message_id: null, screenshot_message_id: null,
      svg_file_name: 'layout.svg', gcode_file_name: null, screenshot_file_name: null,
      svg_content_sha256: 'a'.repeat(64), gcode_content_sha256: null,
      screenshot_content_sha256: null, source_set_fingerprint: 'b'.repeat(64),
      parser_version: 'v1', layout_fingerprint: null, parsed_snapshot_json: {},
      cut_layout_json: null, warnings_json: [], eligibility_status: 'valid',
      duplicate_match_version: 1,
    };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ scan_id: 'scan-1', requested_by: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [candidate], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) };
    const database = {
      transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx),
    } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, {} as never);

    const result = await repository.listCandidates({
      currentUser: { id: 'user-1', username: 'tester', role: 'manager', roleId: 1, permissions: [] },
      scanId: 'scan-1', page: 1, pageSize: 10,
    });

    expect(result.items[0]?.workday).toBe('2026-08-18');
  });

  it('keeps completion source bytes bounded and hash-verifiable by the ingest path', () => {
    expect(dto).toContain('15_728_640');
    expect(source).toContain('CNC_TELEGRAM_SOURCE_FILES_REQUIRED');
    expect(source).toContain('manualSvgUploadInTransaction');
  });

  it('builds the manual SVG ingest item contract from Telegram layout rows', () => {
    const [item] = telegramImportItemsFromLayout({
      status: 'valid',
      reasons: [],
      sheet: { widthMm: 2800, heightMm: 2070 },
      items: [{
        orderName: '2777', detailNumber: 12, widthMm: 400, heightMm: 600, quantity: 1,
        confidence: 0.91, sourceElementId: 'PartContour-1', xMm: 10, yMm: 20,
        placedWidthMm: 400, placedHeightMm: 600, rotated: false,
      }],
    });
    expect(item).toMatchObject({
      sourceItemKey: '2777:12:400:600:PartContour-1',
      orderName: '2777', detailNumber: 12, widthMm: 400, heightMm: 600,
      quantity: 1, source: 'vector', confidence: 0.91,
      matchOrderId: null, matchDetailId: null, matchStatus: 'unmatched',
    });
    expect(() => telegramImportItemsFromLayout({
      status: 'valid', reasons: [], sheet: { widthMm: 2800, heightMm: 2070 },
      items: [{
        orderName: '2777', detailNumber: 12, widthMm: 0, heightMm: 600, quantity: 1,
        xMm: 10, yMm: 20, placedWidthMm: 400, placedHeightMm: 600, rotated: false,
      }],
    })).toThrow('incomplete order/detail/size identity');
  });

  it('infers only uniquely named active orders for the manual ingest DTO', async () => {
    const tx = { query: async () => ({ rows: [{ order_id: '2777' }, { order_id: 2888 }] }) };
    const orderIds = await inferTelegramImportSelectedOrderIds(tx as never, [
      {
        sourceItemKey: '2777:12:400:600:1', orderName: ' 2777 ', detailNumber: 12,
        widthMm: 400, heightMm: 600, quantity: 1, source: 'vector', confidence: 0.99,
      },
      {
        sourceItemKey: '2888:4:300:500:2', orderName: '2888', detailNumber: 4,
        widthMm: 300, heightMm: 500, quantity: 1, source: 'vector', confidence: 0.99,
      },
    ]);
    expect(orderIds).toEqual([2777, 2888]);
  });

  it('fails closed when the order-name query resolves only part of the layout', async () => {
    const tx = { query: async () => ({ rows: [{ order_id: '2777' }] }) };
    const orderIds = await inferTelegramImportSelectedOrderIds(tx as never, [
      {
        sourceItemKey: '2777:12:400:600:1', orderName: '2777', detailNumber: 12,
        widthMm: 400, heightMm: 600, quantity: 1, source: 'vector', confidence: 0.99,
      },
      {
        sourceItemKey: '2888:4:300:500:2', orderName: '2888', detailNumber: 4,
        widthMm: 300, heightMm: 500, quantity: 1, source: 'vector', confidence: 0.99,
      },
    ]);
    expect(orderIds).toEqual([]);
  });

  it('uses the cross-language canonical layout fingerprint contract', () => {
    expect(canonicalLayoutFingerprint({
      status: 'valid',
      reasons: [],
      sheet: { widthMm: 2800, heightMm: 2070 },
      items: [{
        orderName: 'ignored label', detailNumber: 999, widthMm: 100.1234, heightMm: 200.5678,
        quantity: 1, xMm: 10, yMm: 20, placedWidthMm: 100.1234,
        placedHeightMm: 200.5678, rotated: false, sourceElementId: 'ignored-id',
      }],
    })).toBe('808a9b6c7f81e3746ba7139ee7fcc9aa997c88bedacf97fc8b02634baab14bcc');
  });

  it('rejects prefixed fingerprints and source sets above the shared total limit', () => {
    const completion = {
      itemLeaseToken: 't'.repeat(32),
      itemLeaseGeneration: 1,
      itemLeaseOwner: '00000000-0000-4000-8000-000000000001',
      sourceSetFingerprint: 'a'.repeat(64),
      source: {
        sourceChatId: '-1001', sourceMessageId: 1, svgMessageId: 1,
        svgFileName: 'layout.svg', svgContentSha256: 'b'.repeat(64),
      },
      sourceFiles: [1, 2, 3].map((index) => ({
        kind: index === 1 ? 'svg' as const : 'screenshot' as const,
        fileName: `${index}.bin`, contentType: 'application/octet-stream',
        sizeBytes: 13_000_000, sha256: 'b'.repeat(64), base64Content: 'YQ==',
      })),
    };
    expect(() => parseImportComplete(completion)).toThrow();
    expect(() => parseImportComplete({ ...completion, sourceFiles: completion.sourceFiles.slice(0, 1), sourceSetFingerprint: `sha256:${'a'.repeat(64)}` })).toThrow();
    expect(parseImportComplete({ ...completion, sourceFiles: completion.sourceFiles.slice(0, 1) }).sourceFiles).toHaveLength(1);
  });
});
