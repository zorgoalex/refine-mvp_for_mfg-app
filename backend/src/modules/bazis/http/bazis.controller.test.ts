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
  parseAddToOrderBody,
  parseBuildOrderDraftBody,
  parseCreateOrderFromDraftBody,
  parseExportCutXlsBody,
  parseMaterialMappingsQuery,
  parseNodeSearchQuery,
  parseRenameProjectBody,
  parseRevisionTreeQuery,
  parseSetNodeNotesBody,
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

  it('coerces create-order-from-draft body and delegates to the service', async () => {
    const createOrderFromDraft = vi.fn().mockResolvedValue({
      orderId: 601,
      orderName: 'Черновик',
      detailsCreated: 3,
      mappedNodes: 2,
      requestId: 'req-draft-order',
      auditId: 'audit-draft-1',
    });
    const controller = createController({
      bazisEnabled: true,
      service: { createOrderFromDraft },
    });

    const body = createDraftOrderBody();
    const result = await controller.createOrderFromDraft(request(), '12', {
      ...body,
      nodes: [{ clientKey: 'detail-1', bazisNodeId: '101' }],
      idempotencyKey: ' draft-order-key ',
    });

    expect(createOrderFromDraft).toHaveBeenCalledWith({
      currentUser: request().user,
      requestId: 'req-1',
      revisionId: 12,
      order: body.order,
      nodes: [{ clientKey: 'detail-1', bazisNodeId: 101 }],
      idempotencyKey: 'draft-order-key',
    });
    expect(result.orderId).toBe(601);
  });

  it('coerces add-to-order body and delegates to the service', async () => {
    const addToOrder = vi.fn().mockResolvedValue({
      orderId: 9001,
      detailsAdded: 1,
      detailsReplaced: 1,
      requestId: 'req-add-to-order',
    });
    const controller = createController({
      bazisEnabled: true,
      service: { addToOrder },
    });

    const result = await controller.addToOrder(request(), '12', {
      orderId: '9001',
      adds: ['101'],
      replaces: [{ bazisNodeId: '102', orderDetailId: '7002' }],
      skips: [{ bazisNodeId: '103', orderDetailId: '7003' }],
      idempotencyKey: ' add-order-key ',
    });

    expect(addToOrder).toHaveBeenCalledWith({
      currentUser: request().user,
      requestId: 'req-1',
      revisionId: 12,
      orderId: 9001,
      adds: [101],
      replaces: [{ bazisNodeId: 102, orderDetailId: 7002 }],
      skips: [{ bazisNodeId: 103, orderDetailId: 7003 }],
      idempotencyKey: 'add-order-key',
    });
    expect(result).toEqual({
      orderId: 9001,
      detailsAdded: 1,
      detailsReplaced: 1,
      requestId: 'req-add-to-order',
    });
  });

  it('validates add-to-order request body', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(
      controller.addToOrder(request(), '12', {
        orderId: '0',
        adds: ['x'],
        replaces: [{ bazisNodeId: '0', orderDetailId: '1' }],
        skips: [{ bazisNodeId: '1', orderDetailId: '0' }],
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    } satisfies Partial<ApiError>);
  });

  it('validates create-order-from-draft request body', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(
      controller.createOrderFromDraft(request(), '12', {
        order: [],
        nodes: [{ clientKey: '   ', bazisNodeId: '0' }],
        idempotencyKey: '   ',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    } satisfies Partial<ApiError>);
  });

  it('coerces order-draft body and delegates to the service', async () => {
    const buildOrderDraft = vi.fn().mockResolvedValue({
      revisionId: 12,
      projectId: 77,
      clientId: 5,
      clientName: 'ООО Клиент',
      bazisProjectName: 'Шкаф Nova',
      bazisOrderNo: '1457',
      details: [],
      duplicates: [],
    });
    const controller = createController({
      bazisEnabled: true,
      service: { buildOrderDraft },
    });

    const result = await controller.buildOrderDraft(request(), '12', {
      selectedNodeIds: ['101', '102'],
      targetOrderId: '9001',
    });

    expect(buildOrderDraft).toHaveBeenCalledWith({
      currentUser: request().user,
      requestId: 'req-1',
      revisionId: 12,
      selectedNodeIds: [101, 102],
      targetOrderId: 9001,
    });
    expect(result.revisionId).toBe(12);
  });

  it('validates order-draft request body', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(
      controller.buildOrderDraft(request(), '12', {
        selectedNodeIds: Array.from({ length: 501 }, (_, index) => String(index + 1)),
        targetOrderId: '0',
      }),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    } satisfies Partial<ApiError>);
  });

  it('parseBuildOrderDraftBody enforces non-empty node ids and optional positive target order id', () => {
    expect(
      parseBuildOrderDraftBody({ selectedNodeIds: ['1', '2'], targetOrderId: '5' }),
    ).toEqual({
      selectedNodeIds: [1, 2],
      targetOrderId: 5,
    });

    expect(() => parseBuildOrderDraftBody({ selectedNodeIds: [] })).toThrowError(ApiError);
    expect(() => parseBuildOrderDraftBody({ selectedNodeIds: ['1'], targetOrderId: '0' })).toThrowError(
      ApiError,
    );
  });

  it('exports selected panels as XLS and sets download headers', async () => {
    const exportCutXls = vi.fn().mockResolvedValue({
      bytes: Buffer.from('xls'),
      bazisProjectId: 7,
      bazisProjectName: 'Шкаф / тест',
      revisionId: 12,
      positionCount: 2,
      quantity: 3,
    });
    const controller = createController({ bazisEnabled: true, service: { exportCutXls } });
    const response = { setHeader: vi.fn() };

    const file = await controller.exportCutXls(
      request(),
      '12',
      { selectedNodeIds: ['101', '102'] },
      response as never,
    );

    expect(exportCutXls).toHaveBeenCalledWith({
      currentUser: request().user,
      requestId: 'req-1',
      revisionId: 12,
      selectedNodeIds: [101, 102],
    });
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'application/vnd.ms-excel');
    expect(response.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringContaining("filename*=UTF-8''"),
    );
    expect(file).toBeDefined();
  });

  it('fails closed when direct Bazis-cut export is disabled', async () => {
    const controller = createController({ bazisEnabled: true, bazisCutEnabled: false });

    await expect(controller.exportCutXls(
      request(),
      '12',
      { selectedNodeIds: [101] },
      { setHeader: vi.fn() } as never,
    )).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
      details: { feature: 'bazisCut' },
    } satisfies Partial<ApiError>);
  });

  it('validates direct XLS panel selection', () => {
    expect(parseExportCutXlsBody({ selectedNodeIds: ['1', '2'] })).toEqual({ selectedNodeIds: [1, 2] });
    expect(() => parseExportCutXlsBody({ selectedNodeIds: [] })).toThrowError(ApiError);
    expect(() => parseExportCutXlsBody({ selectedNodeIds: [1], extra: true })).toThrowError(ApiError);
  });

  it('parseAddToOrderBody requires a positive order id, pair arrays, and non-empty idempotencyKey', () => {
    expect(
      parseAddToOrderBody({
        orderId: '9001',
        adds: ['101'],
        replaces: [{ bazisNodeId: '102', orderDetailId: '7002' }],
        skips: [],
        idempotencyKey: 'add-order-key',
      }),
    ).toEqual({
      orderId: 9001,
      adds: [101],
      replaces: [{ bazisNodeId: 102, orderDetailId: 7002 }],
      skips: [],
      idempotencyKey: 'add-order-key',
    });

    expect(() =>
      parseAddToOrderBody({
        orderId: 0,
        adds: [],
        replaces: [{ bazisNodeId: 1, orderDetailId: 0 }],
        skips: [],
        idempotencyKey: '',
      }),
    ).toThrowError(ApiError);
  });

  it('parseCreateOrderFromDraftBody requires an order object, node mappings and a non-empty idempotencyKey', () => {
    expect(
      parseCreateOrderFromDraftBody({
        order: createDraftOrderBody().order,
        nodes: [{ clientKey: 'detail-1', bazisNodeId: '10' }],
        idempotencyKey: 'draft-key',
      }),
    ).toEqual({
      order: createDraftOrderBody().order,
      nodes: [{ clientKey: 'detail-1', bazisNodeId: 10 }],
      idempotencyKey: 'draft-key',
    });

    expect(() => parseCreateOrderFromDraftBody({ order: null, nodes: [], idempotencyKey: 'x' })).toThrowError(
      ApiError,
    );
    expect(() =>
      parseCreateOrderFromDraftBody({
        order: createDraftOrderBody().order,
        nodes: [{ clientKey: '', bazisNodeId: 1 }],
        idempotencyKey: '',
      }),
    ).toThrowError(ApiError);
  });

  describe('setNodeNotes', () => {
    it('fails closed 503 when flag off', async () => {
      const controller = createController({ bazisEnabled: false });

      await expect(controller.setNodeNotes(request(), '1', { notes: 'x' })).rejects.toMatchObject({
        statusCode: 503,
        code: 'SERVICE_UNAVAILABLE',
      } satisfies Partial<ApiError>);
    });

    it('requires auth', async () => {
      const controller = createController({ bazisEnabled: true });

      await expect(controller.setNodeNotes({} as RequestWithCurrentUser, '1', { notes: 'x' })).rejects.toMatchObject({
        statusCode: 401,
        code: 'AUTH_REQUIRED',
      } satisfies Partial<ApiError>);
    });

    it('delegates to the service with parsed nodeId and notes', async () => {
      const setNodeNotes = vi.fn().mockResolvedValue({ bazisNodeId: 7213, notes: 'текст' });
      const controller = createController({
        bazisEnabled: true,
        service: { setNodeNotes },
      });

      const result = await controller.setNodeNotes(request(), '7213', { notes: 'текст' });

      expect(result).toEqual({ bazisNodeId: 7213, notes: 'текст' });
      expect(setNodeNotes).toHaveBeenCalledWith(request().user, 'req-1', 7213, 'текст');
    });
  });

  describe('renameProject', () => {
    it('parses id/name and delegates to service', async () => {
      const renameProject = vi.fn().mockResolvedValue({
        bazisProjectId: 41,
        projectId: 77,
        name: '1485',
      });
      const controller = createController({ bazisEnabled: true, service: { renameProject } });

      await expect(controller.renameProject(request(), '41', { name: ' 1485 ' }))
        .resolves.toEqual({ bazisProjectId: 41, projectId: 77, name: '1485' });
      expect(renameProject).toHaveBeenCalledWith(request().user, 'req-1', 41, '1485');
    });

    it('fails closed when feature is disabled', async () => {
      const controller = createController({ bazisEnabled: false });

      await expect(controller.renameProject(request(), '41', { name: '1485' }))
        .rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    });
  });

  describe('parseRenameProjectBody', () => {
    it('trims valid name', () => {
      expect(parseRenameProjectBody({ name: ' 1485 ' })).toEqual({ name: '1485' });
    });

    it.each([{}, { name: '' }, { name: 'x'.repeat(301) }, { name: '1485', extra: true }])(
      'rejects invalid payload %#',
      (body) => {
        expect(() => parseRenameProjectBody(body)).toThrowError(ApiError);
      },
    );
  });

  describe('parseSetNodeNotesBody', () => {
    it('accepts string and null', () => {
      expect(parseSetNodeNotesBody({ notes: 'x' })).toEqual({ notes: 'x' });
      expect(parseSetNodeNotesBody({ notes: null })).toEqual({ notes: null });
    });

    it('rejects missing/extra/typed-wrong payload with 422', () => {
      expect(() => parseSetNodeNotesBody({})).toThrowError(ApiError);
      expect(() => parseSetNodeNotesBody({ notes: 5 })).toThrowError(ApiError);
      expect(() => parseSetNodeNotesBody({ notes: 'x', extra: 1 })).toThrowError(ApiError);
    });
  });
});

function createController(input: {
  bazisEnabled: boolean;
  bazisCutEnabled?: boolean;
  service?: Partial<BazisService>;
}): BazisController {
  const service = {
    importXml: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn(),
    renameProject: vi.fn(),
    getTree: vi.fn(),
    getNodeCard: vi.fn(),
    setNodeNotes: vi.fn(),
    searchNodes: vi.fn(),
    getMaterialsSummary: vi.fn(),
    listRevisionOrders: vi.fn(),
    listMaterialMappings: vi.fn(),
    upsertMaterialMappings: vi.fn(),
    buildOrderDraft: vi.fn(),
    exportCutXls: vi.fn(),
    addToOrder: vi.fn(),
    createOrderFromDraft: vi.fn(),
    createOrderFromRevision: vi.fn(),
    ...input.service,
  } as unknown as BazisService;
  const runtimeConfig = {
    getFeatureFlags: () => ({
      bazisEnabled: input.bazisEnabled,
      bazisCutEnabled: input.bazisCutEnabled ?? true,
    }),
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

function createDraftOrderBody() {
  return {
    order: {
      header: {
        orderName: 'Черновик',
        clientId: 5,
        orderDate: '2026-07-13',
        orderStatusId: 3,
        projectId: 999,
      },
      details: [
        {
          clientKey: 'detail-1',
          detailNumber: 1,
          detailName: 'Панель',
          height: 1000,
          width: 500,
          quantity: 1,
          materialId: null,
          sheetMaterialTypeId: 501,
          millingTypeId: 1,
          edgeTypeId: 1,
        },
      ],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
      deleted: {
        detailIds: [],
        paymentIds: [],
        workshopIds: [],
        requirementIds: [],
        dowelingLinkIds: [],
      },
    },
    nodes: [{ clientKey: 'detail-1', bazisNodeId: 101 }],
    idempotencyKey: 'draft-order-key',
  };
}

describe('BazisController.deleteProject', () => {
  it('parses the id and delegates to the service', async () => {
    const deleteProject = vi.fn().mockResolvedValue({
      bazisProjectId: 41,
      projectId: 77,
      name: 'Шкаф Nova',
      revisionsDeleted: 2,
      nodesDeleted: 639,
    });
    const controller = createController({ bazisEnabled: true, service: { deleteProject } });

    const result = await controller.deleteProject(request(), '41');

    expect(result).toMatchObject({ bazisProjectId: 41, revisionsDeleted: 2 });
    expect(deleteProject).toHaveBeenCalledWith(expect.anything(), expect.anything(), 41);
  });

  it('rejects a non-numeric id with 422', async () => {
    const controller = createController({ bazisEnabled: true });

    await expect(controller.deleteProject(request(), 'abc')).rejects.toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
    } satisfies Partial<ApiError>);
  });

  it('fails closed with 503 when the flag is off', async () => {
    const controller = createController({ bazisEnabled: false });

    await expect(controller.deleteProject(request(), '41')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    } satisfies Partial<ApiError>);
  });
});
