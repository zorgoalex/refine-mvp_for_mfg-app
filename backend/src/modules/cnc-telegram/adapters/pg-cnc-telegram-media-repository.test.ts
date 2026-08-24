import { describe, expect, it, vi } from 'vitest';
import { PgCncTelegramMediaRepository } from './pg-cnc-telegram-media-repository';

const sessionLease = { sourceChatId: '-100', leaseToken: 'session-token', leaseGeneration: 1, workerInstanceId: '00000000-0000-4000-8000-000000000005' };

describe('PgCncTelegramMediaRepository', () => {
  it('lists only order-linked screenshot packets and calculates 30-day availability', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        return { rows: [screenshotRow()] };
      }),
    };
    const repository = new PgCncTelegramMediaRepository(database as never);

    const result = await repository.listOrderScreenshots(2700);

    expect(result[0]).toMatchObject({
      sourceMessageId: 10847,
      originalAvailable: true,
      matchedDetailCount: 2,
    });
    expect(queries[0]?.params).toEqual([2700]);
    expect(queries[0]?.text).toContain("COALESCE(p.source_created_at, p.created_at) + interval '30 days'");
    expect(queries[0]?.text).toContain('COALESCE(item.match_order_id, order_key.order_id)=$1::bigint');
    expect(queries[0]?.text).toContain('p.sheet_image_storage_key IS NOT NULL');
    expect(queries[0]?.text).toContain("p.svg_cut_import_status='imported'");
    expect(queries[0]?.text).toContain('LEFT JOIN cut_job svg_job');
    expect(queries[0]?.text).toContain('svg_job.source_display_number AS svg_cut_job_display_number');
    expect(queries[0]?.text).toContain('cnc_telegram_media_restore_requests');
  });

  it('lists imported SVG cut previews without Telegram media', async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [screenshotRow({
          kind: 'svg_cut',
          source_message_id: null,
          sheet_image_storage_key: null,
          svg_cut_job_id: 74,
          svg_cut_job_display_number: '67',
          svg_cut_result_no: 1,
          svg_cut_group_id: 175,
          svg_cut_sheet_index: 0,
          svg_cut_sheet_number: 1,
          svg_cut_variant: 'auto',
          material_name: 'ХДФ',
        })],
      })),
    };
    const repository = new PgCncTelegramMediaRepository(database as never);

    const result = await repository.listOrderScreenshots(11520);

    expect(result[0]).toMatchObject({
      kind: 'svg_cut',
      sourceMessageId: null,
      materialName: 'ХДФ',
      previewUrl: null,
      imageUrl: null,
      cutJobId: 74,
      cutJobDisplayNumber: '67',
      cutResultNo: 1,
      cutGroupId: 175,
      sheetIndex: 0,
      sheetNumber: 1,
      variant: 'auto',
      originalAvailable: true,
      restore: null,
    });
  });

  it('creates one audited restore request and reuses an active request', async () => {
    const queries: string[] = [];
    let active = false;
    const tx = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('matched_packets AS')) return { rows: [screenshotRow()] };
        if (text.includes("status IN ('pending','processing')")) {
          return { rows: active ? [restoreRow()] : [] };
        }
        if (text.includes('INSERT INTO cnc_telegram_media_restore_requests')) {
          active = true;
          return { rows: [restoreRow()] };
        }
        if (text.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }] };
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn((handler) => handler(tx)) };
    const repository = new PgCncTelegramMediaRepository(database as never);
    const input = {
      orderId: 2700,
      packetId: packetId(),
      currentUser: { id: '42', username: 'operator', role: 'operator', roleId: 11, permissions: ['orders.view'] },
      requestId: 'request-1',
    } as const;

    await expect(repository.requestRestore(input)).resolves.toMatchObject({ status: 'pending' });
    await expect(repository.requestRestore(input)).resolves.toMatchObject({ status: 'pending' });

    expect(queries.filter((query) => query.includes('INSERT INTO cnc_telegram_media_restore_requests'))).toHaveLength(1);
    expect(queries.filter((query) => query.includes('INSERT INTO audit_log'))).toHaveLength(1);
    expect(queries.some((query) => query.includes('pg_advisory_xact_lock'))).toBe(true);
  });

  it('claims bounded allowed-chat tasks with lease recovery and SKIP LOCKED', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      transaction: vi.fn((handler) => handler({
        query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
          queries.push({ text, params });
          if (text.includes('FROM cnc_telegram_worker_session_leases')) return { rows: [{ lease_token: sessionLease.leaseToken }] };
          return { rows: [{
            restore_request_id: restoreId(), packet_id: packetId(), source_chat_id: '-100',
            source_message_id: 10847, sheet_image_storage_key: 'tg_100_10847.jpg', attempt_count: 2,
            lease_token: 'item-token', lease_generation: 1,
            lease_worker_instance_id: sessionLease.workerInstanceId,
          }] };
        }),
      })),
    };
    const repository = new PgCncTelegramMediaRepository(database as never);

    await expect(repository.claimRestores(['-100'], 5, sessionLease)).resolves.toEqual([{
      requestId: restoreId(), packetId: packetId(), sourceChatId: '-100',
      sourceMessageId: 10847, storageKey: 'tg_100_10847.jpg', attempt: 2,
      itemLeaseToken: 'item-token', itemLeaseGeneration: 1,
      itemLeaseOwner: sessionLease.workerInstanceId,
    }]);
    const claimQuery = queries.find(({ text }) => text.includes('WITH candidates AS'));
    expect(claimQuery?.params).toEqual(['-100', 5, sessionLease.workerInstanceId]);
    expect(claimQuery?.text).toContain('FOR UPDATE OF request SKIP LOCKED');
    expect(claimQuery?.text).toContain('request.lease_expires_at <= now()');
  });

  it('lists manual SVG files linked to an order with download URLs', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        return { rows: [manualSvgFileRow()] };
      }),
    };
    const repository = new PgCncTelegramMediaRepository(database as never);

    const result = await repository.listOrderManualSvgFiles(11520);

    expect(result[0]).toMatchObject({
      fileId: manualSvgFileId(),
      kind: 'svg',
      fileName: 'CNC#1_2777+2723-HDF.svg',
      downloadUrl: `/api/v1/cnc-telegram/orders/11520/manual-svg-files/${manualSvgFileId()}`,
      telegramSendStatus: 'sent',
    });
    expect(queries[0]?.params).toEqual([11520]);
    expect(queries[0]?.text).toContain('cnc_manual_svg_upload_file_orders');
    expect(queries[0]?.text).toContain('f.expires_at > now()');
  });

  it('claims manual SVG Telegram sends as pending-only SKIP LOCKED tasks and marks stale processing unknown', async () => {
    const queries: Array<{ text: string; params: readonly unknown[] }> = [];
    const tx = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (text.includes('FROM cnc_telegram_worker_session_leases')) return { rows: [{ lease_token: sessionLease.leaseToken }] };
        if (text.includes('UPDATE cnc_manual_svg_telegram_send_requests') && text.includes("request.status='processing'")) {
          return { rows: [{
            request_id: manualSvgSendRequestId(),
            packet_id: packetId(),
            destination_chat_id: '-100',
            packet_source_chat_id: 'erp-manual-svg-upload',
            previous_status: 'processing',
            state_at: '2026-08-14T04:00:00.000Z',
            attempt_count: 1,
            last_error: 'Статус отправки неизвестен: воркер не завершил запрос после отправки/начала отправки',
          }] };
        }
        if (
          text.includes('UPDATE cnc_manual_svg_telegram_send_requests request') &&
          text.includes("request.status='pending'") &&
          text.includes('NOT EXISTS')
        ) {
          return { rows: [] };
        }
        if (text.includes('INSERT INTO audit_log')) return { rows: [{ audit_id: 'audit-1' }] };
        if (text.includes('WITH candidates AS')) {
          return { rows: [{
            request_id: manualSvgSendRequestId(),
            packet_id: packetId(),
            destination_chat_id: '-100',
            packet_source_chat_id: 'erp-manual-svg-upload',
            cut_job_id: 212,
            cut_job_display_number: '67',
            message_text: 'Фрезы для ХДФ: 8',
            attempt_count: 1,
            files_json: [manualSvgClaimFile()],
            lease_token: 'item-token', lease_generation: 1,
            lease_worker_instance_id: sessionLease.workerInstanceId,
          }] };
        }
        return { rows: [] };
      }),
    };
    const database = { transaction: vi.fn((handler) => handler(tx)) };
    const repository = new PgCncTelegramMediaRepository(database as never);

    await expect(repository.claimManualSvgTelegramSends({
      currentUser: user(),
      limit: 5,
      requestTraceId: 'claim-request-1',
      sessionLease,
    })).resolves.toEqual([{
      requestId: manualSvgSendRequestId(),
      packetId: packetId(),
      destinationChatId: '-100',
      cutJobId: 212,
      cutJobDisplayNumber: '67',
      messageText: 'Фрезы для ХДФ: 8',
      attempt: 1,
      files: [manualSvgClaimFile()], itemLeaseToken: 'item-token', itemLeaseGeneration: 1,
      itemLeaseOwner: sessionLease.workerInstanceId,
    }]);
    const staleQuery = queries.find(({ text }) => text.includes("SET status='unknown'"));
    const auditQuery = queries.find(({ text }) => text.includes('INSERT INTO audit_log'));
    const reconcileQuery = queries.find(({ text }) => text.includes("request.status='pending'") && text.includes('NOT EXISTS'));
    expect(staleQuery?.text).toContain("request.status='processing'");
    expect(auditQuery?.params).toContain('cnc.manual_svg_upload.telegram_send_unknown');
    expect(auditQuery?.params).toContain('claim-request-1');
    expect(reconcileQuery?.text).toContain('claimed_at=COALESCE(claimed_at, now())');
    expect(reconcileQuery?.text).toContain('attempt_count=GREATEST(attempt_count, 1)');
    expect(reconcileQuery?.text).toContain("sent_message_ids_json='[]'::jsonb");
    const claimQuery = queries.find(({ text }) => text.includes('WITH candidates AS'));
    expect(claimQuery?.params).toEqual([5, '-100', sessionLease.workerInstanceId]);
    expect(claimQuery?.text).toContain('request.destination_chat_id=$2');
    expect(claimQuery?.text).not.toContain('packet.source_chat_id=$2');
    expect(claimQuery?.text).toContain('LIMIT $1::integer');
    expect(claimQuery?.text).toContain("WHERE request.status='pending'");
    expect(claimQuery?.text).toContain('JOIN cnc_telegram_packets packet ON packet.packet_id=request.packet_id');
    expect(claimQuery?.text).toContain('JOIN cut_job svg_job ON svg_job.cut_job_id=packet.svg_cut_job_id');
    expect(claimQuery?.text).toContain("packet.svg_cut_import_status='imported'");
    expect(claimQuery?.text).toContain("NULLIF(trim(svg_job.source_display_number::text), '') IS NOT NULL");
    expect(claimQuery?.text).toContain("':mdf-card-created'");
    expect(claimQuery?.text).toContain('FOR UPDATE OF request SKIP LOCKED');
    expect(claimQuery?.text).toContain("encode(file.content_bytes, 'base64')");
    expect(staleQuery?.params).toEqual(['-100']);
    expect(staleQuery?.text).toContain('request.destination_chat_id=$1');
    expect(reconcileQuery?.params).toEqual(['-100']);
    expect(reconcileQuery?.text).toContain('request.destination_chat_id=$1');
    const claimAudit = queries.find(({ params }) => params.includes('cnc.manual_svg_upload.telegram_send_claimed'));
    expect(claimAudit?.params).toContain('claim-request-1');
    expect(claimAudit?.params.some((param) => typeof param === 'string' && param.includes('"destinationChatId":"-100"'))).toBe(true);
    expect(claimAudit?.params.some((param) => typeof param === 'string' && param.includes('"packetSourceChatId":"erp-manual-svg-upload"'))).toBe(true);
  });

  it('rejects manual-send completion from a stale item lease inside the fenced transaction', async () => {
    const queries: string[] = [];
    const tx = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('FROM cnc_telegram_worker_session_leases')) {
          return { rows: [{ lease_token: sessionLease.leaseToken }] };
        }
        if (text.includes('FROM cnc_manual_svg_telegram_send_requests')) {
          return { rows: [manualSendState({ status: 'processing', lease_valid: true })] };
        }
        return { rows: [] };
      }),
    };
    const repository = new PgCncTelegramMediaRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repository.completeManualSvgTelegramSend({
      requestId: manualSvgSendRequestId(),
      currentUser: user(),
      requestTraceId: 'complete-1',
      sessionLease,
      completion: {
        sentChatId: '-100',
        sentMessageIds: ['101'],
        itemLeaseToken: 'x'.repeat(64),
        itemLeaseGeneration: 1,
        itemLeaseOwner: sessionLease.workerInstanceId,
      },
    })).rejects.toMatchObject({ code: 'CNC_TELEGRAM_ITEM_LEASE_STALE', statusCode: 409 });
    expect(queries.some((text) => text.includes("SET status='sent'"))).toBe(false);
  });

  it('replays an exact terminal completion after item expiry without mutating again', async () => {
    const tx = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM cnc_telegram_worker_session_leases')) {
          return { rows: [{ lease_token: sessionLease.leaseToken }] };
        }
        if (text.includes('FROM cnc_manual_svg_telegram_send_requests')) {
          return { rows: [manualSendState({ status: 'sent', lease_valid: false })] };
        }
        return { rows: [] };
      }),
    };
    const repository = new PgCncTelegramMediaRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repository.completeManualSvgTelegramSend({
      requestId: manualSvgSendRequestId(),
      currentUser: user(),
      requestTraceId: 'complete-retry',
      sessionLease,
      completion: {
        sentChatId: '-100',
        sentMessageIds: ['101'],
        itemLeaseToken: 'i'.repeat(64),
        itemLeaseGeneration: 2,
        itemLeaseOwner: sessionLease.workerInstanceId,
      },
    })).resolves.toMatchObject({ status: 'sent', sentMessageIds: ['101'] });
    expect(tx.query.mock.calls.some(([text]) => String(text).includes("SET status='sent'"))).toBe(false);
  });

  it('replays an exact expired restore completion only for the lease chat', async () => {
    const tx = {
      query: vi.fn(async (text: string) => {
        if (text.includes('FROM cnc_telegram_worker_session_leases')) {
          return { rows: [{ lease_token: sessionLease.leaseToken }] };
        }
        if (text.includes('JOIN cnc_telegram_packets')) {
          return { rows: [restoreTerminalState()] };
        }
        return { rows: [] };
      }),
    };
    const repository = new PgCncTelegramMediaRepository({
      transaction: vi.fn((handler) => handler(tx)),
    } as never);

    await expect(repository.completeRestore({
      requestId: restoreId(),
      currentUser: user(),
      requestTraceId: 'restore-retry',
      sessionLease,
      media: {
        storageKey: 'tg_100_10847.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 1200,
        itemLeaseToken: 'r'.repeat(64),
        itemLeaseGeneration: 3,
        itemLeaseOwner: sessionLease.workerInstanceId,
      },
    })).resolves.toMatchObject({ status: 'completed' });
    const restoreQuery = tx.query.mock.calls.find(([text]) => String(text).includes('JOIN cnc_telegram_packets'))?.[0];
    expect(String(restoreQuery)).toContain('packet.source_chat_id=$2');
    expect(tx.query.mock.calls.some(([text]) => String(text).includes('UPDATE cnc_telegram_packets'))).toBe(false);
  });
});

function screenshotRow(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'telegram',
    packet_id: packetId(), source_message_id: 10847, source_created_at: '2026-08-01T08:00:00.000Z',
    program_name: 'CNC.TXT', material_name: 'MDF', sheet_image_storage_key: 'tg_100_10847.jpg',
    sheet_image_content_type: 'image/jpeg', sheet_image_size_bytes: 1200,
    svg_cut_job_id: null, svg_cut_job_display_number: null, svg_cut_result_no: null, svg_cut_group_id: null,
    svg_cut_sheet_index: null, svg_cut_sheet_number: null, svg_cut_variant: null,
    matched_detail_count: 2, item_quantity_total: 3, original_available: true,
    available_until: '2026-08-31T08:00:00.000Z', restore_request_id: null,
    restore_status: null, restore_requested_at: null, restore_error: null,
    ...overrides,
  };
}

function restoreRow() {
  return {
    restore_request_id: restoreId(), packet_id: packetId(), status: 'pending',
    requested_at: '2026-08-07T10:00:00.000Z', available_until: null,
  };
}

function packetId() { return '00000000-0000-4000-8000-000000000001'; }
function restoreId() { return '00000000-0000-4000-8000-000000000002'; }
function manualSvgFileId() { return '00000000-0000-4000-8000-000000000003'; }
function manualSvgSendRequestId() { return '00000000-0000-4000-8000-000000000004'; }

function manualSvgFileRow(overrides: Record<string, unknown> = {}) {
  return {
    file_id: manualSvgFileId(),
    packet_id: packetId(),
    file_kind: 'svg',
    original_file_name: 'CNC#1_2777+2723-HDF.svg',
    content_type: 'image/svg+xml',
    content_sha256: 'a'.repeat(64),
    size_bytes: 1200,
    generated: false,
    created_at: '2026-08-07T10:00:00.000Z',
    expires_at: '2026-09-06T10:00:00.000Z',
    svg_cut_job_id: 212,
    svg_cut_job_display_number: '67',
    svg_cut_result_id: 991,
    svg_cut_result_no: 1,
    telegram_send_status: 'sent',
    ...overrides,
  };
}

function manualSvgClaimFile() {
  return {
    fileId: manualSvgFileId(),
    kind: 'svg',
    fileName: 'CNC#1_2777+2723-HDF.svg',
    contentType: 'image/svg+xml',
    sizeBytes: 11,
    sha256: 'b'.repeat(64),
    base64Content: 'PHN2Zz48L3N2Zz4=',
  };
}

function manualSendState(overrides: Record<string, unknown> = {}) {
  return {
    request_id: manualSvgSendRequestId(),
    packet_id: packetId(),
    status: 'processing',
    requested_at: '2026-08-18T10:00:00.000Z',
    finished_at: '2026-08-18T10:01:00.000Z',
    sent_chat_id: '-100',
    sent_message_ids_json: ['101'],
    last_error: null,
    lease_token: 'i'.repeat(64),
    lease_generation: 2,
    lease_worker_instance_id: sessionLease.workerInstanceId,
    lease_expires_at: '2026-08-18T10:05:00.000Z',
    lease_valid: true,
    ...overrides,
  };
}

function restoreTerminalState() {
  return {
    restore_request_id: restoreId(),
    packet_id: packetId(),
    status: 'completed',
    requested_at: '2026-08-18T10:00:00.000Z',
    available_until: '2026-08-19T10:00:00.000Z',
    source_chat_id: sessionLease.sourceChatId,
    source_message_id: 10847,
    sheet_image_storage_key: 'tg_100_10847.jpg',
    lease_token: 'r'.repeat(64),
    lease_generation: 3,
    lease_worker_instance_id: sessionLease.workerInstanceId,
    lease_expires_at: '2026-08-18T10:05:00.000Z',
    lease_valid: false,
  };
}

function user() {
  return { id: '42', username: 'cnc-worker', role: 'operator', roleId: 11, permissions: ['cut.manage'] };
}
