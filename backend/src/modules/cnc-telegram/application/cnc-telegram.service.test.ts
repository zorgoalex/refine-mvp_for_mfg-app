import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { CncTelegramService } from './cnc-telegram.service';

describe('CncTelegramService', () => {
  it('requires orders.view for original MDF board and delegates authorized reads', async () => {
    const listOriginalBoard = vi.fn().mockResolvedValue({
      dateFrom: '2026-06-19',
      dateTo: '2026-08-19',
      generatedAt: '2026-08-19T12:00:00.000Z',
      packets: [],
      baths: [],
      bazisCutSets: [],
    });
    const packets = {
      listToday: vi.fn(),
      listOriginalBoard,
      listOrderCuttingSequences: vi.fn(),
      ingest: vi.fn(),
      manualSvgUpload: vi.fn(),
      listManualSvgCommentPresets: vi.fn(),
      createManualSvgCommentPreset: vi.fn(),
      configureAutoCutStatus: vi.fn(),
    };
    const service = new CncTelegramService({ packets });

    await expect(service.listOriginalBoard({ currentUser: user([]) }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(listOriginalBoard).not.toHaveBeenCalled();

    await service.listOriginalBoard({ currentUser: user(['orders.view']) });
    expect(listOriginalBoard).toHaveBeenCalledOnce();
  });

  it('requires orders.view for the today projection', async () => {
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('repository must not be called');
        },
        async listOriginalBoard() {
          throw new Error('unused');
        },
        async listOrderCuttingSequences() {
          throw new Error('unused');
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
        async configureAutoCutStatus() {
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
    const deniedAudit = {
      recordIngestDenied: vi.fn().mockResolvedValue(undefined),
      recordAutoCutStatusConfigureDenied: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('unused');
        },
        async listOriginalBoard() {
          throw new Error('unused');
        },
        async listOrderCuttingSequences() {
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
        async configureAutoCutStatus() {
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

  it.each([
    [false, 'CNC_TELEGRAM_BACKGROUND_INGEST_DISABLED', 'BACKGROUND_INGEST_DISABLED'],
    [true, 'CNC_TELEGRAM_BACKGROUND_INGEST_APPROVAL_REQUIRED', 'BACKGROUND_INGEST_APPROVAL_REQUIRED'],
  ] as const)('keeps legacy background ingest fail-closed (enabled=%s)', async (
    backgroundIngestEnabled,
    code,
    reason,
  ) => {
    const ingest = vi.fn();
    const deniedAudit = {
      recordIngestDenied: vi.fn().mockResolvedValue(undefined),
      recordAutoCutStatusConfigureDenied: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CncTelegramService({
      packets: {
        listToday: vi.fn(),
        listOriginalBoard: vi.fn(),
        listOrderCuttingSequences: vi.fn(),
        ingest,
        manualSvgUpload: vi.fn(),
        listManualSvgCommentPresets: vi.fn(),
        createManualSvgCommentPreset: vi.fn(),
        configureAutoCutStatus: vi.fn(),
      },
      deniedAudit,
      backgroundIngestEnabled,
    });

    await expect(service.ingest({
      currentUser: user(['cut.manage']),
      dto: ingestDto(),
      requestId: 'request-background-ingest',
    })).rejects.toMatchObject({ code, statusCode: 503 });
    expect(ingest).not.toHaveBeenCalled();
    expect(deniedAudit.recordIngestDenied).toHaveBeenCalledWith(
      expect.objectContaining({ reason }),
    );
  });

  it('requires orders.view for order cutting sequence numbers', async () => {
    const service = new CncTelegramService({
      packets: {
        async listToday() {
          throw new Error('unused');
        },
        async listOriginalBoard() {
          throw new Error('unused');
        },
        async listOrderCuttingSequences() {
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
        async configureAutoCutStatus() {
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

  it('requires cut.view for Telegram source media', () => {
    const service = new CncTelegramService({
      packets: {
        listToday: vi.fn(),
        listOriginalBoard: vi.fn(),
        listOrderCuttingSequences: vi.fn(),
        ingest: vi.fn(),
        manualSvgUpload: vi.fn(),
        listManualSvgCommentPresets: vi.fn(),
        createManualSvgCommentPreset: vi.fn(),
        configureAutoCutStatus: vi.fn(),
      },
    });

    expect(() => service.assertCanViewMedia(user([]))).toThrowError(expect.objectContaining({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    }));
    expect(() => service.assertCanViewMedia(user(['cut.view']))).not.toThrow();
  });

  it('requires status_automation.manage for auto-cut status and audits denial', async () => {
    const deniedAudit = {
      recordIngestDenied: vi.fn().mockResolvedValue(undefined),
      recordAutoCutStatusConfigureDenied: vi.fn().mockResolvedValue(undefined),
    };
    const configureAutoCutStatus = vi.fn();
    const service = new CncTelegramService({
      packets: {
        listToday: vi.fn(),
        listOriginalBoard: vi.fn(),
        listOrderCuttingSequences: vi.fn(),
        ingest: vi.fn(),
        manualSvgUpload: vi.fn(),
        listManualSvgCommentPresets: vi.fn(),
        createManualSvgCommentPreset: vi.fn(),
        configureAutoCutStatus,
      },
      deniedAudit,
    });

    await expect(service.configureAutoCutStatus({
      currentUser: user(['status_automation.view']),
      enabled: true,
      idempotencyKey: 'cnc-auto-cut-status:test-denied',
      requestId: 'request-denied',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });

    expect(configureAutoCutStatus).not.toHaveBeenCalled();
    expect(deniedAudit.recordAutoCutStatusConfigureDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cnc.telegram_packet.auto_cut_status_configure_denied',
        requiredPermissions: ['status_automation.manage'],
      }),
    );
  });

  it('delegates auto-cut status configuration with manage permission', async () => {
    const response = {
      settingEnabled: true,
      requestId: 'request-allowed',
      auditId: 'audit-allowed',
      completedPacketCount: 2,
      matchedDetailCount: 1,
      wholeOrderCount: 0,
      changedOrderCount: 1,
      changedDetailCount: 1,
    };
    const configureAutoCutStatus = vi.fn().mockResolvedValue(response);
    const service = new CncTelegramService({
      packets: {
        listToday: vi.fn(),
        listOriginalBoard: vi.fn(),
        listOrderCuttingSequences: vi.fn(),
        ingest: vi.fn(),
        manualSvgUpload: vi.fn(),
        listManualSvgCommentPresets: vi.fn(),
        createManualSvgCommentPreset: vi.fn(),
        configureAutoCutStatus,
      },
    });
    const command = {
      currentUser: user(['status_automation.manage']),
      enabled: true,
      idempotencyKey: 'cnc-auto-cut-status:test-allowed',
      requestId: 'request-allowed',
    };

    await expect(service.configureAutoCutStatus(command)).resolves.toEqual(response);
    expect(configureAutoCutStatus).toHaveBeenCalledWith(command);
  });

  it('requires cut.manage for manual SVG upload and records denied audit', async () => {
    const deniedAudit = {
      recordIngestDenied: vi.fn().mockResolvedValue(undefined),
      recordAutoCutStatusConfigureDenied: vi.fn().mockResolvedValue(undefined),
    };
    const manualSvgUpload = vi.fn();
    const service = new CncTelegramService({
      packets: {
        listToday: vi.fn(),
        listOriginalBoard: vi.fn(),
        listOrderCuttingSequences: vi.fn(),
        ingest: vi.fn(),
        manualSvgUpload,
        listManualSvgCommentPresets: vi.fn(),
        createManualSvgCommentPreset: vi.fn(),
        configureAutoCutStatus: vi.fn(),
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
    expect(manualSvgUpload).not.toHaveBeenCalled();
    expect(deniedAudit.recordIngestDenied).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'cnc.manual_svg_upload.denied',
        externalPacketKey: 'a'.repeat(64),
        requiredPermissions: ['cut.manage'],
      }),
    );
  });

  it('assigns the single configured destination to a manual SVG send request', async () => {
    const response = { packetId: 'packet-1' };
    const manualSvgUpload = vi.fn().mockResolvedValue(response);
    const service = new CncTelegramService({
      packets: packetPorts({ manualSvgUpload }),
      manualSvgDestinationChatIds: ['-1001996415689'],
    });
    const command = {
      currentUser: user(['cut.manage']),
      dto: { ...manualSvgDto(), telegramSend: { enabled: true } },
      requestId: 'request-1',
    };

    await expect(service.manualSvgUpload(command)).resolves.toBe(response);
    expect(manualSvgUpload).toHaveBeenCalledWith({
      ...command,
      telegramDestinationChatId: '-1001996415689',
    });
  });

  it.each([[[]], [['-1001', '-1002']]])(
    'fails closed when manual SVG destination is ambiguous: %j',
    async (manualSvgDestinationChatIds) => {
      const manualSvgUpload = vi.fn();
      const service = new CncTelegramService({
        packets: packetPorts({ manualSvgUpload }),
        manualSvgDestinationChatIds,
      });

      await expect(service.manualSvgUpload({
        currentUser: user(['cut.manage']),
        dto: { ...manualSvgDto(), telegramSend: { enabled: true } },
        requestId: 'request-1',
      })).rejects.toMatchObject({
        statusCode: 503,
        code: 'CNC_TELEGRAM_MANUAL_SEND_DESTINATION_UNAVAILABLE',
      });
      expect(manualSvgUpload).not.toHaveBeenCalled();
    },
  );
});

function packetPorts(overrides: Record<string, unknown> = {}) {
  return {
    listToday: vi.fn(),
    listOriginalBoard: vi.fn(),
    listOrderCuttingSequences: vi.fn(),
    ingest: vi.fn(),
    manualSvgUpload: vi.fn(),
    listManualSvgCommentPresets: vi.fn(),
    createManualSvgCommentPreset: vi.fn(),
    configureAutoCutStatus: vi.fn(),
    ...overrides,
  };
}

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
    matchMode: 'order_details' as const,
    validationMode: 'strict' as const,
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
