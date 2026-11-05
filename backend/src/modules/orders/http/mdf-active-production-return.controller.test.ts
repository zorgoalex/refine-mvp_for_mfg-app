import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MdfActiveProductionReturnController } from './mdf-active-production-return.controller';
import type { OrdersRuntimeConfigService } from './orders-runtime-config.service';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';

const calls = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn() }));
vi.mock('../application/mdf-active-production-return.service', () => ({
  MdfActiveProductionReturnService: class {
    preview = calls.preview;
    confirm = calls.confirm;
  },
}));

describe('active MDF correction HTTP contract', () => {
  const packetId = '00000000-0000-0000-0000-000000000101';
  const token = 'a'.repeat(64);
  const digest = 'b'.repeat(64);
  const user = { id: '9', username: 'operator', role: 'admin', roleId: 1, permissions: [] };
  const request = { user, requestId: 'req-active-correction-1' } as unknown as RequestWithCurrentUser;

  beforeEach(() => {
    calls.preview.mockReset();
    calls.confirm.mockReset();
  });

  const controller = (enabled = true, readOnly = false) => new MdfActiveProductionReturnController(
    { preview: calls.preview, confirm: calls.confirm } as never,
    { getFeatureFlags: () => ({ ordersEnabled: enabled, ordersReadOnly: readOnly }) } as OrdersRuntimeConfigService,
  );

  it('checks order availability and authentication before invoking the command', () => {
    expect(() => controller().preview({ requestId: request.requestId } as RequestWithCurrentUser,
      'packet', packetId, { sourceToken: token, targetColumn: 'parsed' })).toThrow('Authentication required');
    expect(() => controller(false).preview(request, 'packet', packetId,
      { sourceToken: token, targetColumn: 'parsed' })).toThrow('недоступны');
    expect(() => controller(true, true).confirm(request, 'packet', packetId, {})).toThrow('недоступны');
    expect(calls.preview).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
  });

  it('requires a source token and strict, bounded request shape', () => {
    const c = controller();
    expect(() => c.preview(request, 'packet', packetId, { targetColumn: 'parsed' })).toThrow();
    expect(() => c.preview(request, 'packet', packetId, { sourceToken: token, targetColumn: 'parsed', actorUserId: 1 })).toThrow();
    expect(() => c.preview(request, 'packet', packetId, { sourceToken: 'A'.repeat(64), targetColumn: 'parsed' })).toThrow();
    expect(() => c.confirm(request, 'packet', packetId, { sourceToken: token, targetColumn: 'parsed',
      expectedDigest: digest, idempotencyKey: 'x'.repeat(129) })).toThrow();
    expect(() => c.confirm(request, 'packet', packetId, { sourceToken: token, targetColumn: 'parsed',
      expectedDigest: digest, idempotencyKey: 'key-1', reason: 'not part of the contract' })).toThrow();
    expect(calls.preview).not.toHaveBeenCalled();
    expect(calls.confirm).not.toHaveBeenCalled();
  });

  it('validates packet, bath, and Bazis source identities before dispatch', () => {
    const c = controller();
    expect(() => c.preview(request, 'packet', 'not-a-uuid', { sourceToken: token, targetColumn: 'parsed' })).toThrow();
    expect(() => c.preview(request, 'bath', 'cut-result:9007199254740992', { sourceToken: token, targetColumn: 'baths' })).toThrow();
    expect(() => c.preview(request, 'bazisCutSet', '-1', { sourceToken: token, targetColumn: 'parsed' })).toThrow();
    expect(() => c.preview(request, 'unknown', '1', { sourceToken: token, targetColumn: 'parsed' })).toThrow();
    expect(calls.preview).not.toHaveBeenCalled();
  });

  it('passes authenticated user, path source, exact body, and request id through unchanged', () => {
    const c = controller();
    const previewBody = { sourceToken: token, targetColumn: 'parsed' as const, productionStatusId: 3 };
    const confirmBody = { ...previewBody, expectedDigest: digest, idempotencyKey: 'cmd:active:1' };
    c.preview(request, 'packet', packetId, previewBody);
    c.confirm(request, 'packet', packetId, confirmBody);
    expect(calls.preview).toHaveBeenCalledWith(user,
      { kind: 'packet', id: packetId }, previewBody, request.requestId);
    expect(calls.confirm).toHaveBeenCalledWith(user,
      { kind: 'packet', id: packetId }, confirmBody, request.requestId);
  });
});
