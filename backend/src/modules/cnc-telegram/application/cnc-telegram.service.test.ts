import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { CncTelegramService } from './cnc-telegram.service';

describe('CncTelegramService', () => {
  it('requires orders.view for the today projection', async () => {
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('repository must not be called');
        },
        async listOrderCuttingSequences() {
          throw new Error('unused');
        },
        async ingest() {
          throw new Error('unused');
        },
      },
    });

    await expect(
      service.listToday({
        currentUser: user([]),
        workday: '2026-07-24',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });

  it('requires cut.manage for structured ingest and records denied audit', async () => {
    const deniedAudit = { recordIngestDenied: vi.fn().mockResolvedValue(undefined) };
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('unused');
        },
        async listOrderCuttingSequences() {
          throw new Error('unused');
        },
        async ingest() {
          throw new Error('repository must not be called');
        },
      },
      deniedAudit,
    });

    await expect(
      service.ingest({
        currentUser: user(['orders.view']),
        dto: ingestDto(),
        requestId: 'request-1',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
    expect(deniedAudit.recordIngestDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cnc.telegram_packet.ingest_denied',
        externalPacketKey: 'packet-1',
        requiredPermissions: ['cut.manage'],
      }),
    );
  });

  it('requires orders.view for order cutting sequence numbers', async () => {
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('unused');
        },
        async listOrderCuttingSequences() {
          throw new Error('repository must not be called');
        },
        async ingest() {
          throw new Error('unused');
        },
      },
    });

    await expect(
      service.listOrderCuttingSequences({
        currentUser: user([]),
        orderId: 2700,
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });
});

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '42',
    username: 'operator',
    role: 'operator',
    roleId: 11,
    permissions,
  };
}

function ingestDto() {
  return {
    idempotencyKey: 'cnc:test:2',
    externalPacketKey: 'packet-1',
    source: {
      chatId: '-100',
      version: 1,
    },
    items: [
      {
        sourceItemKey: 'item-1',
        orderName: '2689',
        quantity: 1,
        source: 'ocr' as const,
        confidence: 0.9,
      },
    ],
  };
}
