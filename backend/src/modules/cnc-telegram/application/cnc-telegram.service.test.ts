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
        async ingest() {
          throw new Error('unused');
        },
        async manualSvgUpload() {
          throw new Error('unused');
        },
        async listManualSvgCommentPresets() {
          throw new Error('unused');
        },
        async createManualSvgCommentPreset() {
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
        async ingest() {
          throw new Error('repository must not be called');
        },
        async manualSvgUpload() {
          throw new Error('unused');
        },
        async listManualSvgCommentPresets() {
          throw new Error('unused');
        },
        async createManualSvgCommentPreset() {
          throw new Error('unused');
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

  it('requires cut.manage for manual SVG upload and records denied audit', async () => {
    const deniedAudit = { recordIngestDenied: vi.fn().mockResolvedValue(undefined) };
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('unused');
        },
        async ingest() {
          throw new Error('unused');
        },
        async manualSvgUpload() {
          throw new Error('repository must not be called');
        },
        async listManualSvgCommentPresets() {
          throw new Error('unused');
        },
        async createManualSvgCommentPreset() {
          throw new Error('unused');
        },
      },
      deniedAudit,
    });

    await expect(
      service.manualSvgUpload({
        currentUser: user(['orders.view']),
        dto: manualSvgDto(),
        requestId: 'request-1',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
    expect(deniedAudit.recordIngestDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cnc.manual_svg_upload.denied',
        externalPacketKey: 'a'.repeat(64),
        requiredPermissions: ['cut.manage'],
      }),
    );
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

function manualSvgDto() {
  return {
    idempotencyKey: 'manual-svg:test:1',
    selectedOrderIds: [42],
    createMdfMachineFileCard: true,
    svgContentHash: 'a'.repeat(64),
    cutLayout: {
      status: 'valid' as const,
      reasons: [],
      sheet: { widthMm: 2070, heightMm: 2800 },
      items: [{
        orderName: '2689',
        detailNumber: 31,
        widthMm: 497,
        heightMm: 477,
        quantity: 1,
        xMm: 0,
        yMm: 0,
        placedWidthMm: 497,
        placedHeightMm: 477,
        rotated: false,
      }],
    },
    items: [{
      sourceItemKey: 'item-1',
      orderName: '2689',
      detailNumber: 31,
      widthMm: 497,
      heightMm: 477,
      quantity: 1,
      source: 'vector' as const,
      confidence: 0.99,
    }],
  };
}
