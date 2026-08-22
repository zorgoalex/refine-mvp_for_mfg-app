import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import {
  projectTelegramLabelMap,
  telegramEvidenceMatchesLayoutItem,
} from './cnc-telegram-label-map-projector';

vi.mock('../../../common/audit/audit.service', () => ({
  auditService: { record: vi.fn().mockResolvedValue('audit-1') },
}));

const source = readFileSync(new URL('./cnc-telegram-label-map-projector.ts', import.meta.url), 'utf8');

describe('Telegram label-map projector structural guards', () => {
  it('persists evidence before callers can aggregate it', () => {
    expect(source).toContain('cnc_telegram_packet_item_evidence');
    expect(source).toContain('evidence_set_digest');
    expect(source).toContain('CNC_TELEGRAM_EVIDENCE_CONFLICT');
  });

  it('renders a label-only SVG and never inserts normal cut placements', () => {
    expect(source).toContain('buildSheetSvg');
    expect(source).toContain('cnc_telegram_label_placement');
    expect(source).not.toContain('INSERT INTO cut_result_placement');
  });

  it('records audit and outbox for actual availability mutations', () => {
    expect(source).toContain('cnc_telegram.item_evidence_persisted');
    expect(source).toContain('cnc_telegram.label_map_projected');
    expect(source).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
  });

  it('uses rotation-aware 3 mm tolerance only for OCR evidence', () => {
    const item = {
      orderName: ' Заказ 42 ',
      detailNumber: 7,
      widthMm: 600,
      heightMm: 320,
    };
    expect(telegramEvidenceMatchesLayoutItem({
      order_name: 'заказ 42', detail_number: 7, width_mm: 318, height_mm: 602, source: 'ocr',
    }, item)).toBe(true);
    expect(telegramEvidenceMatchesLayoutItem({
      order_name: 'заказ 42', detail_number: 7, width_mm: 318, height_mm: 602, source: 'vector',
    }, item)).toBe(false);
    expect(telegramEvidenceMatchesLayoutItem({
      order_name: 'заказ 42', detail_number: 8, width_mm: 600, height_mm: 320, source: 'ocr',
    }, item)).toBe(false);
  });

  it('keeps every contour in mixed SVG but projects only safely matched ERP placements', async () => {
    const placementQueries: Array<readonly unknown[]> = [];
    let sheetInsertParams: readonly unknown[] = [];
    const tx: TransactionClient = {
      raw: {} as never,
      async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
        if (sql.includes('FROM cnc_telegram_packets') && sql.includes('FOR UPDATE')) {
          return result<T>([{
            packet_id: '11111111-1111-4111-8111-111111111111',
            source_version: 2,
            payload_hash: 'sha256:payload',
            source_chat_id: '-100',
            source_message_id: 901,
            source_created_at: '2026-08-07T00:00:00.000Z',
            source_updated_at: '2026-08-07T00:01:00.000Z',
            cut_layout_json: {
              status: 'valid',
              reasons: [],
              sheet: { widthMm: 1000, heightMm: 500 },
              items: [
                layoutItem('Order 1', 31, 10, 20),
                layoutItem('External', 99, 400, 20),
              ],
            },
          }]);
        }
        if (sql.includes('FROM cnc_telegram_label_sheet_map') && sql.includes('WHERE packet_id')) return result<T>([]);
        if (sql.includes('FROM cnc_telegram_packet_evidence_set')) {
          return result<T>([{ payload_hash: 'sha256:payload', evidence_set_digest: 'sha256:evidence', item_count: 2 }]);
        }
        if (sql.includes('FROM cnc_telegram_packet_item_evidence')) {
          return result<T>([
            {
              payload_hash: 'sha256:payload', source_item_key: 'matched', order_name: 'Order 1', detail_number: 31,
              width_mm: 200, height_mm: 100, quantity: 1, source: 'vector', match_order_id: 7,
              match_detail_id: 70, match_status: 'matched',
            },
            {
              payload_hash: 'sha256:payload', source_item_key: 'external', order_name: 'External', detail_number: 99,
              width_mm: 200, height_mm: 100, quantity: 1, source: 'vector', match_order_id: null,
              match_detail_id: null, match_status: 'unmatched',
            },
          ]);
        }
        if (sql.includes('FROM order_details od')) {
          return result<T>([{ detail_id: 70, order_id: 7, width: 200, height: 100, quantity: 1 }]);
        }
        if (sql.includes('INSERT INTO cnc_telegram_label_sheet_map')) {
          sheetInsertParams = params;
          return result<T>([{ telegram_label_sheet_map_id: 88 }]);
        }
        if (sql.includes('INSERT INTO cnc_telegram_label_placement')) {
          placementQueries.push(params);
          return result<T>([]);
        }
        if (sql.includes('INSERT INTO outbox_events')) return result<T>([]);
        throw new Error(`Unexpected query: ${sql}`);
      },
    };

    await expect(projectTelegramLabelMap(tx, {
      packetId: '11111111-1111-4111-8111-111111111111',
      source: 'ingest',
      context: { actorUserId: 1, requestId: 'request-1' },
    })).resolves.toEqual({ projected: true, sheetMapId: 88 });
    expect(sheetInsertParams[12]).toBe(2);
    expect(sheetInsertParams[13]).toBe(1);
    expect(String(sheetInsertParams[7]).match(/class="cut-sheet-piece"/g)).toHaveLength(2);
    expect(placementQueries).toHaveLength(1);
    expect(placementQueries[0]?.[2]).toBe(70);
  });
});

function result<T extends QueryResultRow>(rows: QueryResultRow[]) {
  return { rows: rows as T[], rowCount: rows.length, command: '', oid: 0, fields: [] };
}

function layoutItem(orderName: string, detailNumber: number, xMm: number, yMm: number) {
  return {
    orderName,
    detailNumber,
    widthMm: 200,
    heightMm: 100,
    quantity: 1,
    xMm,
    yMm,
    placedWidthMm: 200,
    placedHeightMm: 100,
    rotated: false,
  };
}
