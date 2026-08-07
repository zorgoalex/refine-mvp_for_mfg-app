import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import type { CncTelegramWorkerAuditService } from '../application/cnc-telegram-worker-audit.service';
import { CncTelegramWorkerAuditController } from './cnc-telegram-worker-audit.controller';

describe('CncTelegramWorkerAuditController detailed export', () => {
  it('returns a private UTF-8 JSON attachment with parsed filters', async () => {
    const exportDetailed = vi.fn().mockResolvedValue({
      fileName: 'telegram-worker-audit_2026-08-01_2026-08-06.json',
      content: '{"schemaVersion":1}\n',
    });
    const controller = new CncTelegramWorkerAuditController({
      exportDetailed,
    } as unknown as CncTelegramWorkerAuditService);
    const response = {
      setHeader: vi.fn(),
      send: vi.fn(),
    } as unknown as Response;
    const request = {
      user: { id: '7', username: 'auditor', role: 'admin', roleId: 1, permissions: ['audit.view'] },
      requestId: 'request-export',
    } as RequestWithCurrentUser;

    await controller.exportDetailed(request, {
      dateFrom: '2026-08-01',
      dateTo: '2026-08-06',
      status: 'failed',
    }, response);

    expect(exportDetailed).toHaveBeenCalledWith(request.user, {
      dateFrom: '2026-08-01',
      dateTo: '2026-08-06',
      status: 'failed',
    });
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="telegram-worker-audit_2026-08-01_2026-08-06.json"',
    );
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    expect(response.send).toHaveBeenCalledWith('{"schemaVersion":1}\n');
  });
});
