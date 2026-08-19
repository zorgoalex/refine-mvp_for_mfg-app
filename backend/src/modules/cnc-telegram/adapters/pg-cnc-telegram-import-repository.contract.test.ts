import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import { canonicalLayoutFingerprint } from './pg-cnc-telegram-repository';
import {
  PgCncTelegramImportRepository,
  assertCncTelegramScanMessageCount,
  assertTerminalItemLeaseReplay,
  inferTelegramImportSelectedOrderIds,
  telegramImportItemsFromLayout,
} from './pg-cnc-telegram-import-repository';
import { parseImportComplete } from '../dto/cnc-telegram-import.dto';

const source = readFileSync(new URL('./pg-cnc-telegram-import-repository.ts', import.meta.url), 'utf8');
const svgRepositorySource = readFileSync(new URL('../adapters/pg-cnc-telegram-repository.ts', import.meta.url), 'utf8');
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
    expect(result.items[0]?.sourceMessageId).toBe('42');
    expect(result.items[0]?.svgMessageId).toBe('42');
  });

  it('fails the transaction path when a scan exceeds 5000 distinct messages', () => {
    expect(() => assertCncTelegramScanMessageCount(5000)).not.toThrow();
    expect(() => assertCncTelegramScanMessageCount(5001)).toThrow('cannot persist more than 5000');
    expect(source.indexOf('INSERT INTO cnc_telegram_import_scan_messages')).toBeLessThan(source.indexOf('SELECT count(*) AS total'));
    expect(source.indexOf('SELECT count(*) AS total')).toBeLessThan(source.indexOf('assertCncTelegramScanMessageCount'));
  });

  it('returns scan-owned messages in chronological order without coercing BIGINT ids to JS numbers', async () => {
    const message = {
      scan_message_id: 'message-1', scan_id: 'scan-1', source_chat_id: '-1001',
      source_message_id: '9007199254740993', source_thread_id: '9007199254740994',
      reply_to_message_id: null, sender_user_id: '9007199254740995',
      source_created_at: '2026-08-18T10:00:00.000Z', source_updated_at: null,
      workday: new Date(2026, 7, 18), message_type: 'image', filename: null,
      mime_type: 'image/jpeg', message_text: 'Раскрой', outgoing: false,
      candidate_id: 'candidate-1', candidate_role: 'screenshot', read_ordinal: 1,
    };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ scan_id: 'scan-1', requested_by: 'user-1' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ ...message, total: '1' }], rowCount: 1 }) };
    const database = {
      transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx),
    } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, {} as never);

    const result = await repository.listMessages({
      currentUser: { id: 'user-1', username: 'tester', role: 'manager', roleId: 1, permissions: [] },
      scanId: 'scan-1', page: 2, pageSize: 10,
    });

    expect(result).toMatchObject({ total: 1, items: [{
      sourceMessageId: '9007199254740993',
      sourceThreadId: '9007199254740994',
      senderUserId: '9007199254740995',
      workday: '2026-08-18', candidateRole: 'screenshot',
    }] });
    expect(tx.query).toHaveBeenLastCalledWith(expect.stringContaining('ORDER BY m.source_created_at ASC'), ['scan-1', 10, 10]);
  });

  it('keeps exact BIGINT source id through duplicate-match refresh queries', async () => {
    const sourceMessageId = '9007199254740993';
    const candidate = {
      candidate_id: 'candidate-1', source_chat_id: '-1001', source_message_id: sourceMessageId,
      svg_content_sha256: 'a'.repeat(64), layout_fingerprint: null,
    };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // matches before refresh
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // delete old matches
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // same Telegram source
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // manual upload source
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // exact SVG source
      .mockResolvedValueOnce({ rows: [{ match_kind: 'same_telegram_source', packet_id: 'packet-1', cut_job_id: null, cut_result_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // duplicate version bump
      .mockResolvedValueOnce({ rows: [{ ...candidate, duplicate_match_version: 2 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ match_kind: 'same_telegram_source', packet_id: 'packet-1', cut_job_id: null, cut_result_id: null }], rowCount: 1 }) };
    const database = {
      transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx),
    } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, {} as never);

    const refreshed = await (repository as unknown as {
      refreshMatches: (client: typeof tx, row: typeof candidate) => Promise<typeof candidate>;
      matches: (client: typeof tx, candidateId: string) => Promise<unknown>;
    }).refreshMatches(tx, candidate);
    const duplicateMatches = await (repository as unknown as {
      matches: (client: typeof tx, candidateId: string) => Promise<unknown>;
    }).matches(tx, 'candidate-1');

    expect(refreshed).toMatchObject({ candidate_id: 'candidate-1', duplicate_match_version: 2 });
    expect(duplicateMatches).toEqual([{ kind: 'same_telegram_source', packetId: 'packet-1', cutJobId: null, cutResultId: null }]);
    expect(tx.query.mock.calls[2]?.[1]).toEqual(['candidate-1', '-1001', sourceMessageId]);
    expect(tx.query.mock.calls[3]?.[1]).toEqual(['candidate-1', sourceMessageId, '-1001']);
    expect(tx.query.mock.calls[2]?.[0]).toContain('p.source_message_id=$3::bigint');
  });

  it('keeps unresolved Telegram orders informational while preserving matched-order linking', () => {
    expect(source).not.toContain('assertTelegramImportCandidateOrdersResolvable');
    expect(source).toContain("matchMode: 'order_details', validationMode: 'lenient'");
    expect(svgRepositorySource).toContain('if (manualDto.selectedOrderIds.length > 0)');
    expect(svgRepositorySource).toContain('buildTelegramInformationalSvgCutImportPlan');
  });

  it('prepares an unresolved Telegram candidate instead of rejecting it before the worker', async () => {
    const queries: string[] = [];
    const candidate = {
      candidate_id: 'candidate-2808', scan_id: 'scan-1', source_chat_id: '-1001',
      source_message_id: 42, svg_content_sha256: 'a'.repeat(64), layout_fingerprint: null,
      source_set_fingerprint: 'b'.repeat(64), duplicate_match_version: 1,
      eligibility_status: 'valid', expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    const request = {
      import_request_id: 'request-1', scan_id: 'scan-1', requested_by: 'user-1',
      request_hash: 'hash', selection_hash: 'selection', status: 'draft', confirmation_id: 'confirmation-1',
      selected_count: 1, imported_count: 0, failed_count: 0, error_message: null, duplicate_match_version: 1,
      repeat_of_import_request_id: null,
    };
    const tx = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM cnc_telegram_import_scans')) return { rows: [{ scan_id: 'scan-1', requested_by: 'user-1', status: 'ready' }], rowCount: 1 };
      if (sql.includes('FROM cnc_telegram_import_candidates WHERE scan_id')) return { rows: [candidate], rowCount: 1 };
      if (sql.includes('FROM cnc_telegram_import_requests WHERE requested_by')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO cnc_telegram_import_requests')) return { rows: [request], rowCount: 1 };
      if (sql.includes('FROM cnc_telegram_import_items WHERE import_request_id')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }) };
    const database = { transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx) } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, {} as never);

    await expect(repository.prepare({
      currentUser: { id: 'user-1', username: 'tester', role: 'manager', roleId: 1, permissions: [] },
      scanId: 'scan-1', candidateIds: ['candidate-2808'], requestId: 'request-1', idempotencyKey: 'key-1',
    })).resolves.toMatchObject({ importRequestId: 'request-1' });
    expect(queries.some((sql) => sql.includes('FROM orders'))).toBe(false);
    expect(queries.some((sql) => sql.includes('INSERT INTO cnc_telegram_import_requests'))).toBe(true);
    expect(queries.some((sql) => sql.includes('INSERT INTO cnc_telegram_import_items'))).toBe(true);
  });

  it('completes an unresolved Telegram SVG through the importer in lenient mode without selected orders', async () => {
    const candidate = {
      import_item_id: 'item-1', import_request_id: 'request-1', requested_by: 'user-1', scan_id: 'scan-1',
      source_chat_id: '-1001', source_message_id: 42, source_thread_id: null,
      source_created_at: '2026-08-19T10:00:00.000Z', source_updated_at: null, workday: '2026-08-19',
      svg_message_id: 42, gcode_message_id: null, screenshot_message_id: null,
      svg_file_name: 'CNC#1_2808+2807.svg', gcode_file_name: null, screenshot_file_name: null,
      svg_content_sha256: 'a'.repeat(64), gcode_content_sha256: null, screenshot_content_sha256: null,
      source_set_fingerprint: 'b'.repeat(64), parser_version: 'test', layout_fingerprint: null,
      parsed_snapshot_json: {}, cut_layout_json: {
        status: 'valid', reasons: [], sheet: { widthMm: 2800, heightMm: 2070 },
        items: [{ orderName: '2808', detailNumber: 1, widthMm: 400, heightMm: 600, quantity: 1, xMm: 0, yMm: 0, placedWidthMm: 400, placedHeightMm: 600, rotated: false }],
      }, warnings_json: [], eligibility_status: 'valid', duplicate_match_version: 1,
      duplicate_snapshot_json: [], status: 'processing', duplicate_acknowledged: true,
      lease_token: 'l'.repeat(32), lease_generation: 1, lease_worker_instance_id: '00000000-0000-4000-8000-000000000001',
    };
    const queries: string[] = [];
    const tx = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('FROM cnc_telegram_worker_session_leases')) return { rows: [{ lease_token: 's' }], rowCount: 1 };
      if (sql.includes('FROM cnc_telegram_import_items i JOIN cnc_telegram_import_requests')) return { rows: [candidate], rowCount: 1 };
      if (sql.includes('WHERE i.import_item_id=$1 AND c.source_chat_id')) return { rows: [candidate], rowCount: 1 };
      if (sql.includes('FROM users u JOIN roles')) return { rows: [{ user_id: 'user-1', username: 'requester', role_id: 1, role_code: 'manager' }], rowCount: 1 };
      if (sql.includes('FROM orders o')) return { rows: [], rowCount: 0 };
      if (sql.includes('UPDATE cnc_telegram_import_items SET status=\'imported\'')) return { rows: [candidate], rowCount: 1 };
      if (sql.includes('SELECT match_kind')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }) };
    const importer = { manualSvgUploadInTransaction: vi.fn().mockResolvedValue({ packet: { packetId: 'packet-1' }, cutJobId: 800, cutResultId: null }) };
    const database = { transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx) } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, importer as never);

    await repository.completeImport({
      currentUser: { id: 'worker-1', username: 'worker', role: 'worker', roleId: 1, permissions: [] },
      importItemId: 'item-1',
      lease: { sourceChatId: '-1001', leaseToken: 's', leaseGeneration: 1, workerInstanceId: '00000000-0000-4000-8000-000000000002' },
      completion: {
        itemLeaseToken: 'l'.repeat(32), itemLeaseGeneration: 1, itemLeaseOwner: '00000000-0000-4000-8000-000000000001',
        sourceSetFingerprint: 'b'.repeat(64),
        source: { sourceChatId: '-1001', sourceMessageId: '42', svgMessageId: '42', gcodeMessageId: null, screenshotMessageId: null, svgFileName: 'CNC#1_2808+2807.svg', gcodeFileName: null, screenshotFileName: null, svgContentSha256: 'a'.repeat(64), gcodeContentSha256: null, screenshotContentSha256: null },
        sourceFiles: [{ kind: 'svg', fileName: 'CNC#1_2808+2807.svg', contentType: 'image/svg+xml', sizeBytes: 1, sha256: 'a'.repeat(64), base64Content: 'YQ==' }],
      },
      requestId: 'request-1',
    });

    expect(importer.manualSvgUploadInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      dto: expect.objectContaining({ matchMode: 'order_details', validationMode: 'lenient', selectedOrderIds: [] }),
    }));
    expect(queries.some((sql) => sql.includes('INSERT INTO cut_job'))).toBe(false); // importer owns cut-job creation
  });

  it('returns an idempotent same-hash request before revalidating ERP orders', async () => {
    const candidateId = 'candidate-2812';
    const selectionHash = createHash('sha256').update(JSON.stringify(['scan-1', 'user-1', [candidateId], null])).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify({ selectionHash, actor: 'user-1', repeat: null })).digest('hex');
    const prior = {
      import_request_id: 'request-1', scan_id: 'scan-1', requested_by: 'user-1', request_hash: requestHash,
      status: 'draft', confirmation_id: 'confirmation-1', selected_count: 1, imported_count: 0,
      failed_count: 0, error_message: null, selection_hash: selectionHash, duplicate_match_version: 1,
      repeat_of_import_request_id: null,
    };
    const candidate = {
      candidate_id: candidateId, scan_id: 'scan-1', eligibility_status: 'valid',
      expires_at: new Date(Date.now() + 60_000).toISOString(), cut_layout_json: null,
    };
    const tx = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ scan_id: 'scan-1', requested_by: 'user-1', status: 'ready' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [candidate], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [prior], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) };
    const database = {
      transaction: async <T>(handler: (client: typeof tx) => Promise<T>): Promise<T> => handler(tx),
    } as unknown as DatabaseService;
    const repository = new PgCncTelegramImportRepository(database, {} as never);

    await expect(repository.prepare({
      currentUser: { id: 'user-1', username: 'tester', role: 'manager', roleId: 1, permissions: [] },
      scanId: 'scan-1', candidateIds: [candidateId], requestId: 'request-retry', idempotencyKey: 'key-1',
    })).resolves.toMatchObject({ importRequestId: 'request-1' });
    expect(tx.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('FROM orders'))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO cnc_telegram_import_requests'))).toBe(false);
    expect(tx.query.mock.calls.some(([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO cnc_telegram_import_items'))).toBe(false);
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
    const parsed = parseImportComplete({ ...completion, sourceFiles: completion.sourceFiles.slice(0, 1) });
    expect(parsed.sourceFiles).toHaveLength(1);
    expect(parsed.source.sourceMessageId).toBe('1');
    expect(parsed.source.svgMessageId).toBe('1');
  });
});
