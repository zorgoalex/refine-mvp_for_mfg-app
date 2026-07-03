import { describe, expect, it, vi } from 'vitest';
import { LabelsService, validateQrElementNames } from './labels.service';

function fakeRepo() {
  return {
    listQrTemplates: vi.fn().mockResolvedValue([]),
    createQrTemplate: vi.fn().mockResolvedValue({ labelQrTemplateId: 1 }),
    updateQrTemplate: vi.fn(),
    deleteQrTemplate: vi.fn(),
    recordPermissionDenied: vi.fn().mockResolvedValue(undefined),
  } as any;
}
// PermissionsService reads user.permissions.includes(...) — fixtures MUST carry permissions.
const admin = { id: '1', username: 'admin', role: 'admin', roleId: 1, permissions: ['labels.view', 'labels.manage_templates'] } as any;
const operator = { id: '2', username: 'op', role: 'operator', roleId: 2, permissions: [] } as any;
const ctx = (currentUser: any) => ({ currentUser, requestId: 'r1' });

describe('LabelsService qr templates', () => {
  it('operator cannot create (permission denied + audit)', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    await expect(service.createQrTemplate({ ...ctx(operator), input: validInput() }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(repo.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ targetEntityType: 'label_qr_template' }),
    );
    expect(repo.createQrTemplate).not.toHaveBeenCalled();
  });

  it('admin create validates non-empty content', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    await expect(service.createQrTemplate({ ...ctx(admin), input: { ...validInput(), contentTemplate: '   ' } }))
      .rejects.toMatchObject({ statusCode: 422 });
  });

  it('admin create rejects an unsupported field placeholder', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    await expect(service.createQrTemplate({ ...ctx(admin), input: { ...validInput(), contentTemplate: '{unknown.field}' } }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(repo.createQrTemplate).not.toHaveBeenCalled();
  });

  it('admin create succeeds', async () => {
    const repo = fakeRepo();
    const service = new LabelsService({ repo });
    await service.createQrTemplate({ ...ctx(admin), input: validInput() });
    expect(repo.createQrTemplate).toHaveBeenCalledOnce();
  });
});

describe('validateQrElementNames', () => {
  it('rejects duplicate qr names', () => {
    expect(() => validateQrElementNames([
      { kind: 'qr', style: { qrName: 'A' } },
      { kind: 'qr', style: { qrName: 'a' } },
    ] as any)).toThrow(/unique/i);
  });
  it('rejects empty qr name', () => {
    expect(() => validateQrElementNames([{ kind: 'qr', style: {} } as any])).toThrow(/name/i);
  });
});

function validInput() {
  return { name: 'Деталь', contentTemplate: '{bazis.detail_id}', errorCorrection: 'M', defaultSizeMm: 20, idempotencyKey: 'qr-key-123456' };
}
