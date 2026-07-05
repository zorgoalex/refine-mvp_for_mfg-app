import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import type { LabelOcrTemplateDto, LabelsPort, OcrPort } from './labels.types';
import { LabelsService } from './labels.service';

const manager: CurrentUser = {
  id: '10',
  username: 'manager',
  role: 'manager',
  roleId: 10,
  permissions: ['labels.view', 'labels.generate'],
};

const templateManager: CurrentUser = {
  id: '11',
  username: 'template-manager',
  role: 'admin',
  roleId: 1,
  permissions: ['labels.view', 'labels.manage_templates'],
};

const sampleDto: LabelOcrTemplateDto = {
  labelOcrTemplateId: 1,
  name: 'Реализация',
  rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
  sampleLines: [],
  isActive: true,
  version: 1,
};

function makeService(overrides: { repo?: Partial<LabelsPort>; ocr?: Partial<OcrPort> } = {}) {
  const repo: Partial<LabelsPort> = {
    recordPermissionDenied: vi.fn().mockResolvedValue(undefined),
    listOcrTemplates: vi.fn().mockResolvedValue([sampleDto]),
    createOcrTemplate: vi.fn().mockResolvedValue(sampleDto),
    updateOcrTemplate: vi.fn().mockResolvedValue(sampleDto),
    deleteOcrTemplate: vi.fn().mockResolvedValue(undefined),
    listActiveOcrTemplatesForMatch: vi.fn().mockResolvedValue([]),
    ...overrides.repo,
  };
  const ocr: Partial<OcrPort> = {
    recognize: vi.fn().mockResolvedValue({ lines: [], durationMs: 0 }),
    ...overrides.ocr,
  };
  const service = new LabelsService({ repo: repo as LabelsPort, ocr: ocr as OcrPort });
  return {
    service,
    repo: repo as unknown as Record<keyof LabelsPort, ReturnType<typeof vi.fn>>,
    ocr: ocr as unknown as Record<keyof OcrPort, ReturnType<typeof vi.fn>>,
  };
}

describe('LabelsService.previewOcrLabel', () => {
  it('rejects a caller without labels.manage_templates', async () => {
    const { service, ocr } = makeService();
    await expect(
      service.previewOcrLabel({
        currentUser: manager,
        requestId: 'req-1',
        image: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('returns raw OCR lines (text + score) and durationMs', async () => {
    const { service } = makeService({
      ocr: {
        recognize: vi.fn().mockResolvedValue({
          lines: [
            { text: '671', score: 0.95 },
            { text: '649 X 238', score: 0.9 },
          ],
          durationMs: 77,
        }),
      },
    });
    const result = await service.previewOcrLabel({
      currentUser: templateManager,
      requestId: 'req-2',
      image: Buffer.from('x'),
      contentType: 'image/png',
    });
    expect(result).toEqual({
      lines: [
        { text: '671', score: 0.95 },
        { text: '649 X 238', score: 0.9 },
      ],
      durationMs: 77,
    });
  });

  it('fails closed 503 when no OcrPort is configured', async () => {
    const repo: Partial<LabelsPort> = { recordPermissionDenied: vi.fn().mockResolvedValue(undefined) };
    const service = new LabelsService({ repo: repo as LabelsPort });
    await expect(
      service.previewOcrLabel({
        currentUser: templateManager,
        requestId: 'req-3',
        image: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'OCR_SERVICE_UNAVAILABLE' });
  });
});

describe('LabelsService.testOcrTemplate', () => {
  it('rejects a caller without labels.manage_templates', async () => {
    const { service, ocr } = makeService();
    await expect(
      service.testOcrTemplate({
        currentUser: manager,
        requestId: 'req-1',
        image: Buffer.from('x'),
        contentType: 'image/png',
        rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('matches the candidate rule set against a real photo and reports the legacy fallback too', async () => {
    const { service } = makeService({
      ocr: {
        recognize: vi.fn().mockResolvedValue({
          lines: [
            { text: '671', score: 0.95 },
            { text: 'лДСп Дуб Гарден 16мм', score: 0.85 },
            { text: '649 X 238', score: 0.9 },
          ],
          durationMs: 55,
        }),
      },
    });
    const result = await service.testOcrTemplate({
      currentUser: templateManager,
      requestId: 'req-2',
      image: Buffer.from('x'),
      contentType: 'image/png',
      rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
    });

    expect(result.lines).toEqual([
      { text: '671', score: 0.95 },
      { text: 'лДСп Дуб Гарден 16мм', score: 0.85 },
      { text: '649 X 238', score: 0.9 },
    ]);
    expect(result.matched.templateWon).toBe(true);
    expect(result.matched.fields).toMatchObject({
      orderName: '671',
      material: 'ЛДСП',
      width: 649,
      height: 238,
    });
    expect(result.fallbackFields).toBeDefined();
  });

  it('templateWon is false when the candidate rule set does not pass the match thresholds', async () => {
    const { service } = makeService({
      ocr: {
        recognize: vi.fn().mockResolvedValue({
          lines: [{ text: 'какой-то нечитаемый мусор', score: 0.4 }],
          durationMs: 10,
        }),
      },
    });
    const result = await service.testOcrTemplate({
      currentUser: templateManager,
      requestId: 'req-3',
      image: Buffer.from('x'),
      contentType: 'image/png',
      rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
    });
    expect(result.matched.templateWon).toBe(false);
    expect(result.matched.score).toBe(0);
    expect(result.matched.fields).toEqual({});
  });
});

describe('LabelsService OCR template CRUD', () => {
  it('listOcrTemplates delegates to repo with the correct require()', async () => {
    const { service, repo } = makeService();
    const result = await service.listOcrTemplates({ currentUser: manager, requestId: 'req-1' });
    expect(result).toEqual([sampleDto]);
    expect(repo.listOcrTemplates).toHaveBeenCalledWith({ currentUser: manager, requestId: 'req-1' });
  });

  it('listOcrTemplates rejects a caller without labels.view', async () => {
    const { service, repo } = makeService();
    await expect(
      service.listOcrTemplates({ currentUser: { ...manager, permissions: [] }, requestId: 'req-2' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.listOcrTemplates).not.toHaveBeenCalled();
  });

  it('createOcrTemplate rejects a caller without labels.manage_templates (403), repo NOT called', async () => {
    const { service, repo } = makeService();
    await expect(
      service.createOcrTemplate({
        currentUser: manager,
        requestId: 'req-3',
        input: {
          name: 'Реализация',
          rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
          sampleLines: [],
          isActive: true,
          idempotencyKey: 'idem-key-0001',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.createOcrTemplate).not.toHaveBeenCalled();
  });

  it('createOcrTemplate delegates to repo when permitted and input is valid', async () => {
    const { service, repo } = makeService();
    const result = await service.createOcrTemplate({
      currentUser: templateManager,
      requestId: 'req-4',
      input: {
        name: 'Реализация',
        rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
        sampleLines: [],
        isActive: true,
        idempotencyKey: 'idem-key-0002',
      },
    });
    expect(result).toEqual(sampleDto);
    expect(repo.createOcrTemplate).toHaveBeenCalledTimes(1);
  });

  it('createOcrTemplate rejects invalid input (only 1 strong field) with 422 OCR_TEMPLATE_INVALID, repo NOT called', async () => {
    const { service, repo } = makeService();
    await expect(
      service.createOcrTemplate({
        currentUser: templateManager,
        requestId: 'req-5',
        input: {
          name: 'Неполный',
          rules: [{ field: 'order_number' }],
          sampleLines: [],
          isActive: true,
          idempotencyKey: 'idem-key-0003',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'OCR_TEMPLATE_INVALID' });
    expect(repo.createOcrTemplate).not.toHaveBeenCalled();
  });

  it('createOcrTemplate rejects input missing a discriminant (2 strong fields, no dimensions/material/anchor)', async () => {
    const { service, repo } = makeService();
    await expect(
      service.createOcrTemplate({
        currentUser: templateManager,
        requestId: 'req-5b',
        input: {
          name: 'Без дискриминанта',
          rules: [{ field: 'order_number' }, { field: 'detail_number' }],
          sampleLines: [],
          isActive: true,
          idempotencyKey: 'idem-key-0003b',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'OCR_TEMPLATE_INVALID' });
    expect(repo.createOcrTemplate).not.toHaveBeenCalled();
  });

  it('updateOcrTemplate delegates to repo with correct require() (targetId = command.id)', async () => {
    const { service, repo } = makeService();
    const result = await service.updateOcrTemplate({
      currentUser: templateManager,
      requestId: 'req-6',
      id: 1,
      expectedVersion: 1,
      input: {
        name: 'Реализация v2',
        rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
        sampleLines: [],
        isActive: true,
        idempotencyKey: 'idem-key-0004',
      },
    });
    expect(result).toEqual(sampleDto);
    expect(repo.updateOcrTemplate).toHaveBeenCalledTimes(1);
  });

  it('updateOcrTemplate rejects a caller without labels.manage_templates, repo NOT called', async () => {
    const { service, repo } = makeService();
    await expect(
      service.updateOcrTemplate({
        currentUser: manager,
        requestId: 'req-7',
        id: 1,
        expectedVersion: 1,
        input: {
          name: 'Реализация v2',
          rules: [{ field: 'order_number' }, { field: 'material' }, { field: 'dimensions' }],
          sampleLines: [],
          isActive: true,
          idempotencyKey: 'idem-key-0005',
        },
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.updateOcrTemplate).not.toHaveBeenCalled();
  });

  it('deleteOcrTemplate delegates to repo with correct require()', async () => {
    const { service, repo } = makeService();
    await service.deleteOcrTemplate({
      currentUser: templateManager,
      requestId: 'req-8',
      id: 1,
      expectedVersion: 1,
      idempotencyKey: 'idem-key-0006',
    });
    expect(repo.deleteOcrTemplate).toHaveBeenCalledWith({
      currentUser: templateManager,
      requestId: 'req-8',
      id: 1,
      expectedVersion: 1,
      idempotencyKey: 'idem-key-0006',
    });
  });

  it('deleteOcrTemplate rejects a caller without labels.manage_templates, repo NOT called', async () => {
    const { service, repo } = makeService();
    await expect(
      service.deleteOcrTemplate({
        currentUser: manager,
        requestId: 'req-9',
        id: 1,
        expectedVersion: 1,
        idempotencyKey: 'idem-key-0007',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(repo.deleteOcrTemplate).not.toHaveBeenCalled();
  });
});
