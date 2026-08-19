import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalLayoutFingerprint } from './pg-cnc-telegram-repository';
import {
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
