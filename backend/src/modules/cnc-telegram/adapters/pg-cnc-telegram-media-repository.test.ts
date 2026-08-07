import { describe, expect, it, vi } from 'vitest';
import { PgCncTelegramMediaRepository } from './pg-cnc-telegram-media-repository';

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
    expect(queries[0]?.text).toContain("p.source_created_at + interval '30 days'");
    expect(queries[0]?.text).toContain('COALESCE(item.match_order_id, order_key.order_id)=$1::bigint');
    expect(queries[0]?.text).toContain('p.sheet_image_storage_key IS NOT NULL');
    expect(queries[0]?.text).toContain('cnc_telegram_media_restore_requests');
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
          return { rows: [{
            restore_request_id: restoreId(), packet_id: packetId(), source_chat_id: '-100',
            source_message_id: 10847, sheet_image_storage_key: 'tg_100_10847.jpg', attempt_count: 2,
          }] };
        }),
      })),
    };
    const repository = new PgCncTelegramMediaRepository(database as never);

    await expect(repository.claimRestores(['-100'], 5)).resolves.toEqual([{
      requestId: restoreId(), packetId: packetId(), sourceChatId: '-100',
      sourceMessageId: 10847, storageKey: 'tg_100_10847.jpg', attempt: 2,
    }]);
    expect(queries[0]?.params).toEqual([['-100'], 5]);
    expect(queries[0]?.text).toContain('FOR UPDATE OF request SKIP LOCKED');
    expect(queries[0]?.text).toContain("request.claimed_at < now() - interval '5 minutes'");
  });
});

function screenshotRow() {
  return {
    packet_id: packetId(), source_message_id: 10847, source_created_at: '2026-08-01T08:00:00.000Z',
    program_name: 'CNC.TXT', material_name: 'MDF', sheet_image_storage_key: 'tg_100_10847.jpg',
    sheet_image_content_type: 'image/jpeg', sheet_image_size_bytes: 1200,
    matched_detail_count: 2, item_quantity_total: 3, original_available: true,
    available_until: '2026-08-31T08:00:00.000Z', restore_request_id: null,
    restore_status: null, restore_requested_at: null, restore_error: null,
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
