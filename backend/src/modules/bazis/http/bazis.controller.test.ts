import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import type { BazisService } from '../application/bazis.service';
import {
  BazisController,
  parseBazisImportFields,
  parseMaterialMappingsQuery,
  parseNodeSearchQuery,
  parseRevisionTreeQuery,
  parseUpsertMaterialMappingsBody,
} from './bazis.controller';
import type { BazisRuntimeConfigService } from './bazis-runtime-config.service';

describe('BazisController', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bazis-controller-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('fails closed with 503 SERVICE_UNAVAILABLE when the flag is off', async () => {
    const controller = createController({ bazisEnabled: false });

    await expect(controller.listProjects(request(), {})).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'bazis' },
    } satisfies Partial<ApiError>);
  });

  it('requires an authenticated user', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(controller.listProjects({}, {})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('rejects importXml without file with 422', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(controller.importXml(request(), undefined, { projectId: '12' })).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Файл не передан',
    } satisfies Partial<ApiError>);
  });

  it('coerces multipart numeric fields, delegates to the service, and unlinks the temp file', async () => {
    const filePath = join(tempDir, 'upload.xml');
    await writeFile(filePath, '<Проект><Изделие/></Проект>', 'utf8');
    const importXml = vi.fn().mockResolvedValue({
      bazisProject: { bazisProjectId: 1, projectId: 12, name: 'Проект' },
      revision: { bazisRevisionId: 2, revisionNo: 1, xmlSha256: 'sha', summary: {} },
      unmappedMaterials: [],
      warnings: [],
      requestId: 'req-import',
    });
    const controller = createController({
      bazisEnabled: true,
      service: { importXml },
    });

    const result = await controller.importXml(
      request(),
      { path: filePath, size: 123, originalname: 'upload.xml' },
      { projectId: '12' },
    );

    expect(importXml).toHaveBeenCalledWith({
      currentUser: request().user,
      requestId: 'req-1',
      projectId: 12,
      bazisProjectId: null,
      fileName: 'upload.xml',
      filePath,
    });
    await expect(stat(filePath)).rejects.toThrow();
    expect(result.requestId).toBe('req-import');
  });

  it('requires projectId or bazisProjectId for import', async () => {
    const controller = createController({ bazisEnabled: true });
    const filePath = join(tempDir, 'upload.xml');
    await writeFile(filePath, '<Проект><Изделие/></Проект>', 'utf8');

    await expect(
      controller.importXml(request(), { path: filePath, size: 10, originalname: 'upload.xml' }, {}),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Нужен projectId или bazisProjectId',
    } satisfies Partial<ApiError>);
  });

  it('parseBazisImportFields coerces multipart strings to numbers', () => {
    expect(parseBazisImportFields({ projectId: '12', bazisProjectId: '7' })).toEqual({
      projectId: 12,
      bazisProjectId: 7,
    });
  });

  it('parseRevisionTreeQuery accepts optional parentNodeId', () => {
    expect(parseRevisionTreeQuery({})).toEqual({ parentNodeId: null, all: false });
    expect(parseRevisionTreeQuery({ parentNodeId: '4' })).toEqual({ parentNodeId: 4, all: false });
  });

  it('parseRevisionTreeQuery parses all=true and rejects it with parentNodeId', () => {
    expect(parseRevisionTreeQuery({ all: 'true' })).toEqual({ parentNodeId: null, all: true });
    expect(parseRevisionTreeQuery({ all: 'false' })).toEqual({ parentNodeId: null, all: false });
    expect(() => parseRevisionTreeQuery({ all: 'true', parentNodeId: '4' })).toThrow();
  });

  it('parseMaterialMappingsQuery splits comma-separated names', () => {
    expect(parseMaterialMappingsQuery({ names: 'oak%20white,edge-1' })).toEqual({
      names: ['oak white', 'edge-1'],
    });
  });

  it('parseNodeSearchQuery accepts q, objectType, and explicit limit', () => {
    expect(parseNodeSearchQuery({ q: '  шкаф  ', objectType: '  panel  ', limit: '25' })).toEqual({
      q: 'шкаф',
      objectType: 'panel',
      limit: 25,
    });
  });

  it('parseNodeSearchQuery rejects missing q and objectType', () => {
    expect(() => parseNodeSearchQuery({})).toThrowError(ApiError);
  });

  it('parseNodeSearchQuery rejects limit above the maximum', () => {
    expect(() => parseNodeSearchQuery({ q: 'шкаф', limit: '999' })).toThrowError(ApiError);
  });

  it('parseNodeSearchQuery defaults limit to 50', () => {
    expect(parseNodeSearchQuery({ objectType: 'panel' })).toEqual({
      q: null,
      objectType: 'panel',
      limit: 50,
    });
  });

  it('rejects cross-kind material mappings (targetKind must match sourceKind or be ignore)', () => {
    expect(() =>
      parseUpsertMaterialMappingsBody({
        items: [{ sourceKind: 'sheet', bazisName: 'ЛДСП Белый', targetKind: 'film', filmId: 3 }],
      }),
    ).toThrowError(ApiError);

    expect(() =>
      parseUpsertMaterialMappingsBody({
        items: [{ sourceKind: 'edge', bazisName: 'Кромка 2мм', targetKind: 'sheet', sheetMaterialTypeId: 1 }],
      }),
    ).toThrowError(ApiError);

    // Валидные формы проходят: совпадающий контекст и ignore.
    expect(
      parseUpsertMaterialMappingsBody({
        items: [
          { sourceKind: 'film', bazisName: 'Плёнка ПВХ', targetKind: 'film', filmId: 3 },
          { sourceKind: 'sheet', bazisName: 'Стекло', targetKind: 'ignore' },
        ],
      }).items,
    ).toHaveLength(2);
  });

  it('coerces create-order body and delegates to the service', async () => {
    const createOrderFromRevision = vi.fn().mockResolvedValue({
      orderId: 501,
      orderName: 'Новый заказ',
      detailsCreated: 2,
      mappedNodes: 2,
      requestId: 'req-order',
      auditId: 'audit-1',
    });
    const controller = createController({
      bazisEnabled: true,
      service: { createOrderFromRevision },
    });

    const result = await controller.createOrderFromRevision(request(), '12', {
      clientId: '77',
      orderName: '  Новый заказ  ',
      orderStatusId: '3',
      selectedNodeIds: ['101', '102'],
      idempotencyKey: 'bazis-key-001',
    });

    expect(createOrderFromRevision).toHaveBeenCalledWith({
      currentUser: request().user,
      requestId: 'req-1',
      revisionId: 12,
      clientId: 77,
      orderName: 'Новый заказ',
      orderStatusId: 3,
      selectedNodeIds: [101, 102],
      idempotencyKey: 'bazis-key-001',
    });
    expect(result.orderId).toBe(501);
  });

  it('validates create-order request body', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(
      controller.createOrderFromRevision(request(), '12', {
        clientId: '0',
        orderName: '   ',
        orderStatusId: '0',
        selectedNodeIds: [],
        idempotencyKey: 'short',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    } satisfies Partial<ApiError>);
  });
});

function createController(input: {
  bazisEnabled: boolean;
  service?: Partial<BazisService>;
}): BazisController {
  const service = {
    importXml: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn(),
    getTree: vi.fn(),
    getNodeCard: vi.fn(),
    searchNodes: vi.fn(),
    getMaterialsSummary: vi.fn(),
    listRevisionOrders: vi.fn(),
    listMaterialMappings: vi.fn(),
    upsertMaterialMappings: vi.fn(),
    createOrderFromRevision: vi.fn(),
    ...input.service,
  } as unknown as BazisService;
  const runtimeConfig = {
    getFeatureFlags: () => ({ bazisEnabled: input.bazisEnabled }),
  } as BazisRuntimeConfigService;
  return new BazisController(service, runtimeConfig);
}

function request(): RequestWithCurrentUser {
  return {
    user: {
      id: '1',
      username: 'manager',
      role: 'manager',
      roleId: 1,
      permissions: ['bazis.manage', 'bazis.view'],
    },
    requestId: 'req-1',
  };
}
