import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { ApiError } from '../../../common/errors/api-error';
import { BazisParseFailedError } from '../errors/bazis.errors';
import type { BazisRepositoryPort } from './bazis.types';
import { BazisXmlParseError } from './bazis-xml-parser';
import { BazisService } from './bazis.service';

const { parseBazisXml } = vi.hoisted(() => ({
  parseBazisXml: vi.fn(),
}));

vi.mock('./bazis-xml-parser', async () => {
  const actual = await vi.importActual<typeof import('./bazis-xml-parser')>('./bazis-xml-parser');
  return {
    ...actual,
    parseBazisXml,
  };
});

const fixtureParsed = {
  bazisVersion: '12',
  bazisOrderNo: null,
  designEngineerName: null,
  productName: 'Шкаф',
  productPrice: 100,
  nodes: [],
  materials: [],
  summary: {
    totalNodes: 0,
    panels: 0,
    hardware: 0,
    assemblies: 0,
    blocks: 0,
    uniqueMaterials: 0,
  },
};

describe('BazisService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bazis-service-'));
    parseBazisXml.mockReset();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rejects importXml without bazis.manage and does not call the repository', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    await expect(
      service.importXml({
        currentUser: viewerUser(),
        requestId: 'req-1',
        projectId: 10,
        bazisProjectId: null,
        fileName: 'sample.xml',
        filePath: await writeFixtureFile(tempDir, 'sample.xml', '<Проект/>'),
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.manage'] },
      message: 'Недостаточно прав для работы с Базис-импортом',
    } satisfies Partial<ApiError>);

    expect(repository.importRevision).not.toHaveBeenCalled();
  });

  it('writes a best-effort denied audit row when auditDatabase is provided', async () => {
    const repository = createRepository();
    const auditQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ audit_id: 'aud-denied-1' }], rowCount: 1 });
    const service = new BazisService({
      repository,
      auditDatabase: { query: auditQuery },
    });

    await expect(
      service.importXml({
        currentUser: viewerUser(),
        requestId: 'req-denied',
        projectId: 10,
        bazisProjectId: null,
        fileName: 'sample.xml',
        filePath: await writeFixtureFile(tempDir, 'sample.xml', '<Проект/>'),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    const auditInsert = auditQuery.mock.calls.find(([text]) =>
      String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('),
    );
    expect(auditInsert).toBeDefined();
    const params = auditInsert?.[1] as unknown[];
    expect(params[0]).toBe('bazis.permission_denied');
    expect(params[1]).toBe('bazis');
    expect(params[2]).toBe('import_xml');
    expect(repository.importRevision).not.toHaveBeenCalled();
  });

  it('still throws 403 when the denied-audit write itself fails', async () => {
    const repository = createRepository();
    const service = new BazisService({
      repository,
      auditDatabase: { query: vi.fn().mockRejectedValue(new Error('db down')) },
    });

    await expect(
      service.listProjects(managerUser(), {}),
    ).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(repository.listProjects).not.toHaveBeenCalled();
  });

  it('rejects read methods without bazis.view', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    await expect(service.listProjects(managerUser(), {})).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.view'] },
    } satisfies Partial<ApiError>);

    await expect(service.getProject(managerUser(), 1)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.view'] },
    } satisfies Partial<ApiError>);

    await expect(service.getTree(managerUser(), 2, null)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.view'] },
    } satisfies Partial<ApiError>);

    await expect(service.listMaterialMappings(managerUser(), ['oak'])).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.view'] },
    } satisfies Partial<ApiError>);

    expect(repository.listProjects).not.toHaveBeenCalled();
    expect(repository.getProject).not.toHaveBeenCalled();
    expect(repository.getTreeChildren).not.toHaveBeenCalled();
    expect(repository.listMaterialMappings).not.toHaveBeenCalled();
  });

  describe('viewer reads', () => {
    it.each([
      ['getNodeCard', (service: BazisService, user: CurrentUser) => service.getNodeCard(user, 555)],
      ['searchNodes', (service: BazisService, user: CurrentUser) =>
        service.searchNodes(user, 82, { q: 'шкаф', objectType: null, limit: 50 })],
      ['getMaterialsSummary', (service: BazisService, user: CurrentUser) =>
        service.getMaterialsSummary(user, 82)],
      ['listRevisionOrders', (service: BazisService, user: CurrentUser) =>
        service.listRevisionOrders(user, 82)],
      ['getFullTree', (service: BazisService, user: CurrentUser) =>
        service.getFullTree(user, 82)],
      ['getRevisionEstimate', (service: BazisService, user: CurrentUser) =>
        service.getRevisionEstimate(user, 82)],
    ])('%s requires bazis.view', async (_name, call) => {
      await expect(call(createService(), managerUser())).rejects.toMatchObject({ statusCode: 403 });
      await expect(call(createService(), viewerUser())).resolves.toBeDefined();
    });
  });

  it('requires both bazis.view and cut.view for direct XLS export', async () => {
    const repository = createRepository();
    const service = createService(repository);
    const command = {
      requestId: 'req-export',
      revisionId: 82,
      selectedNodeIds: [101, 102],
    };

    await expect(service.exportCutXls({ ...command, currentUser: viewerUser() }))
      .rejects.toMatchObject({
        statusCode: 403,
        details: { requiredPermissions: ['cut.view'] },
      } satisfies Partial<ApiError>);
    await expect(service.exportCutXls({ ...command, currentUser: cutOnlyUser() }))
      .rejects.toMatchObject({
        statusCode: 403,
        details: { requiredPermissions: ['bazis.view'] },
      } satisfies Partial<ApiError>);
    await expect(service.exportCutXls({ ...command, currentUser: bazisCutViewer() }))
      .resolves.toMatchObject({ revisionId: 82, positionCount: 2 });
    expect(repository.exportCutXls).toHaveBeenCalledTimes(1);
  });

  describe('manager writes', () => {
    it.each([
      ['deleteProject', (service: BazisService, user: CurrentUser) => service.deleteProject(user, 'req', 41)],
      ['renameProject', (service: BazisService, user: CurrentUser) => service.renameProject(user, 'req', 41, '1485')],
      ['setProjectDesignEngineer', (service: BazisService, user: CurrentUser) =>
        service.setProjectDesignEngineer(user, 'req', 41, 10)],
      ['setNodeNotes', (service: BazisService, user: CurrentUser) => service.setNodeNotes(user, 'req', 1, 'x')],
    ])('%s requires bazis.manage', async (_name, call) => {
      await expect(call(createService(), viewerUser())).rejects.toMatchObject({ statusCode: 403 });
      await expect(call(createService(), bazisManager())).resolves.toBeDefined();
    });
  });

  it('streams sha256 and gzip from disk, parses once, and delegates importRevision', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });
    const xml = await readFile(
      new URL('./__fixtures__/bazis-sample.xml', import.meta.url),
      'utf8',
    );
    const filePath = await writeFixtureFile(tempDir, 'bazis.xml', xml);
    parseBazisXml.mockReturnValue(fixtureParsed);

    const result = await service.importXml({
      currentUser: bazisManager(),
      requestId: 'req-import',
      projectId: 12,
      bazisProjectId: null,
      fileName: 'bazis.xml',
      filePath,
    });

    expect(parseBazisXml).toHaveBeenCalledTimes(1);
    expect(parseBazisXml).toHaveBeenCalledWith(xml);
    expect(repository.importRevision).toHaveBeenCalledTimes(1);
    expect(repository.importRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUser: bazisManager(),
        requestId: 'req-import',
        projectId: 12,
        bazisProjectId: null,
        fileName: 'bazis.xml',
        fileSize: Buffer.byteLength(xml),
        xmlSha256: createHash('sha256').update(xml).digest('hex'),
        parsed: fixtureParsed,
      }),
    );
    const command = repository.importRevision.mock.calls[0]?.[0];
    expect(command).toBeDefined();
    expect(gunzipSync(command.rawXmlGzip).toString('utf8')).toBe(xml);
    expect(result.requestId).toBe('req-import');
  });

  it('rejects a second concurrent import with BazisImportBusyError', async () => {
    const repository = createRepository({
      importRevision: vi.fn(
        async () =>
          await new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  bazisProject: { bazisProjectId: 1, projectId: 1, name: 'P' },
                  revision: { bazisRevisionId: 1, revisionNo: 1, xmlSha256: 'sha', summary: {} },
                  unmappedMaterials: [],
                  warnings: [],
                  requestId: 'busy',
                }),
              50,
            ),
          ),
      ),
    });
    const service = new BazisService({ repository });
    const filePath = await writeFixtureFile(tempDir, 'busy.xml', '<Проект><Изделие/></Проект>');
    parseBazisXml.mockReturnValue(fixtureParsed);

    const first = service.importXml({
      currentUser: bazisManager(),
      requestId: 'req-1',
      projectId: 1,
      bazisProjectId: null,
      fileName: 'busy.xml',
      filePath,
    });

    await expect(
      service.importXml({
        currentUser: bazisManager(),
        requestId: 'req-2',
        projectId: 1,
        bazisProjectId: null,
        fileName: 'busy.xml',
        filePath,
      }),
    ).rejects.toMatchObject({
      statusCode: 429,
      code: 'BAZIS_IMPORT_BUSY',
    } satisfies Partial<ApiError>);

    await first;
  });

  it('records failed imports on BazisXmlParseError and throws BazisParseFailedError', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });
    const xml = '<Проект><Изделие><broken></Изделие></Проект>';
    const filePath = await writeFixtureFile(tempDir, 'broken.xml', xml);
    parseBazisXml.mockImplementation(() => {
      throw new BazisXmlParseError('XML не распарсился');
    });

    await expect(
      service.importXml({
        currentUser: bazisManager(),
        requestId: 'req-bad',
        projectId: 7,
        bazisProjectId: null,
        fileName: 'broken.xml',
        filePath,
      }),
    ).rejects.toBeInstanceOf(BazisParseFailedError);

    expect(repository.recordFailedImport).toHaveBeenCalledWith({
      currentUser: bazisManager(),
      requestId: 'req-bad',
      fileName: 'broken.xml',
      xmlSha256: createHash('sha256').update(xml).digest('hex'),
      errorMessage: 'XML не распарсился',
    });
    expect(repository.importRevision).not.toHaveBeenCalled();
  });

  it('requires bazis.manage for deleteProject', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    await expect(
      service.deleteProject(viewerUser(), 'req-delete', 41),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.manage'] },
    } satisfies Partial<ApiError>);

    expect(repository.deleteProject).not.toHaveBeenCalled();
  });

  it('delegates deleteProject when bazis.manage is present', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    const result = await service.deleteProject(bazisManager(), 'req-delete', 41);

    expect(result).toMatchObject({ bazisProjectId: 41, revisionsDeleted: 2 });
    expect(repository.deleteProject).toHaveBeenCalledWith({
      currentUser: bazisManager(),
      requestId: 'req-delete',
      bazisProjectId: 41,
    });
  });

  describe('BazisService.renameProject normalization', () => {
    it('trims and delegates a valid name', async () => {
      const repository = createRepository();
      const service = createService(repository);

      await service.renameProject(bazisManager(), 'req-rename', 41, '  1485  ');

      expect(repository.renameProject).toHaveBeenCalledWith({
        currentUser: bazisManager(),
        requestId: 'req-rename',
        bazisProjectId: 41,
        name: '1485',
      });
    });

    it.each(['   ', 'x'.repeat(301)])('rejects invalid name %j with 422', async (name) => {
      const repository = createRepository();
      const service = createService(repository);

      await expect(
        service.renameProject(bazisManager(), 'req-rename', 41, name),
      ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_ERROR' });
      expect(repository.renameProject).not.toHaveBeenCalled();
    });
  });

  describe('BazisService.setNodeNotes normalization', () => {
    it('trims and coerces empty to null', async () => {
      const repository = createRepository();
      repository.setNodeNotes.mockResolvedValue({ bazisNodeId: 1, notes: null });
      const service = createService(repository);

      await service.setNodeNotes(bazisManager(), 'req', 1, '   ');

      expect(repository.setNodeNotes).toHaveBeenCalledWith(
        expect.objectContaining({ nodeId: 1, notes: null }),
      );
    });

    it('rejects notes longer than 2000 chars after trim with 422', async () => {
      const service = createService();

      await expect(
        service.setNodeNotes(bazisManager(), 'req', 1, 'а'.repeat(2001)),
      ).rejects.toMatchObject({ statusCode: 422, code: 'VALIDATION_FAILED' });
    });

    it('passes trimmed value through', async () => {
      const repository = createRepository();
      repository.setNodeNotes.mockResolvedValue({ bazisNodeId: 1, notes: 'текст' });
      const service = createService(repository);

      await service.setNodeNotes(bazisManager(), 'req', 1, '  текст  ');

      expect(repository.setNodeNotes).toHaveBeenCalledWith(
        expect.objectContaining({ notes: 'текст' }),
      );
    });
  });

  it('requires bazis.view for buildOrderDraft', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    await expect(
      service.buildOrderDraft({
        currentUser: managerUser(),
        requestId: 'req-draft',
        revisionId: 1,
        selectedNodeIds: [4],
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.view'] },
    } satisfies Partial<ApiError>);

    expect(repository.buildOrderDraft).not.toHaveBeenCalled();
  });

  it('requires orders.update for buildOrderDraft when targetOrderId is present and writes denied-audit', async () => {
    const repository = createRepository();
    const auditQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ audit_id: 'aud-denied-order-draft' }], rowCount: 1 });
    const service = new BazisService({
      repository,
      auditDatabase: { query: auditQuery },
    });

    await expect(
      service.buildOrderDraft({
        currentUser: viewerUser(),
        requestId: 'req-draft',
        revisionId: 1,
        selectedNodeIds: [4],
        targetOrderId: 55,
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.update'] },
    } satisfies Partial<ApiError>);

    const auditInsert = auditQuery.mock.calls.find(([text]) =>
      String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('),
    );
    expect(auditInsert).toBeDefined();
    const params = auditInsert?.[1] as unknown[];
    expect(params[2]).toBe('order_draft');
    expect(params.some((param) => String(param).includes('"action":"order_draft"'))).toBe(true);
    expect(repository.buildOrderDraft).not.toHaveBeenCalled();
  });

  it('delegates buildOrderDraft with bazis.view only when targetOrderId is absent', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    const result = await service.buildOrderDraft({
      currentUser: viewerUser(),
      requestId: 'req-draft',
      revisionId: 1,
      selectedNodeIds: [4, 5],
    });

    expect(repository.buildOrderDraft).toHaveBeenCalledWith({
      currentUser: viewerUser(),
      requestId: 'req-draft',
      revisionId: 1,
      selectedNodeIds: [4, 5],
    });
    expect(result.revisionId).toBe(1);
  });

  it('delegates buildOrderDraft when both bazis.view and orders.update are present', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    await service.buildOrderDraft({
      currentUser: ordersUpdaterUser(),
      requestId: 'req-draft',
      revisionId: 1,
      selectedNodeIds: [4, 5],
      targetOrderId: 77,
    });

    expect(repository.buildOrderDraft).toHaveBeenCalledWith({
      currentUser: ordersUpdaterUser(),
      requestId: 'req-draft',
      revisionId: 1,
      selectedNodeIds: [4, 5],
      targetOrderId: 77,
    });
  });

  it('requires bazis.manage for createOrderFromRevision', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    await expect(
      service.createOrderFromRevision({
        currentUser: viewerUser(),
        requestId: 'req-order',
        revisionId: 1,
        clientId: 2,
        orderName: 'Order',
        orderStatusId: 3,
        selectedNodeIds: [4],
        idempotencyKey: 'bazis-order-001',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.manage'] },
    } satisfies Partial<ApiError>);

    expect(repository.createOrderFromRevision).not.toHaveBeenCalled();
  });

  it('delegates createOrderFromRevision when bazis.manage is present', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    const result = await service.createOrderFromRevision({
      currentUser: bazisManager(),
      requestId: 'req-order',
      revisionId: 1,
      clientId: 2,
      orderName: 'Order',
      orderStatusId: 3,
      selectedNodeIds: [4, 5],
      idempotencyKey: 'bazis-order-001',
    });

    expect(repository.createOrderFromRevision).toHaveBeenCalledWith({
      currentUser: bazisManager(),
      requestId: 'req-order',
      revisionId: 1,
      clientId: 2,
      orderName: 'Order',
      orderStatusId: 3,
      selectedNodeIds: [4, 5],
      idempotencyKey: 'bazis-order-001',
    });
    expect(result.orderId).toBe(1);
  });

  it('requires bazis.manage for createOrderFromDraft and writes denied-audit', async () => {
    const repository = createRepository();
    const auditQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ audit_id: 'aud-denied-create-from-draft' }], rowCount: 1 });
    const service = new BazisService({
      repository,
      auditDatabase: { query: auditQuery },
    });

    await expect(
      service.createOrderFromDraft({
        currentUser: viewerUser(),
        requestId: 'req-draft-order',
        revisionId: 82,
        order: createDraftOrder(),
        nodes: [{ clientKey: 'detail-1', bazisNodeId: 101 }],
        idempotencyKey: 'draft-order-key-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.manage'] },
    } satisfies Partial<ApiError>);

    const auditInsert = auditQuery.mock.calls.find(([text]) =>
      String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('),
    );
    expect(auditInsert).toBeDefined();
    const params = auditInsert?.[1] as unknown[];
    expect(params[2]).toBe('create_order_from_draft');
    expect(params.some((param) => String(param).includes('"action":"create_order_from_draft"'))).toBe(true);
    expect(repository.createOrderFromDraft).not.toHaveBeenCalled();
  });

  it('requires orders.create for createOrderFromDraft after bazis.manage and writes denied-audit', async () => {
    const repository = createRepository();
    const auditQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ audit_id: 'aud-denied-orders-create' }], rowCount: 1 });
    const service = new BazisService({
      repository,
      auditDatabase: { query: auditQuery },
    });

    await expect(
      service.createOrderFromDraft({
        currentUser: bazisManager(),
        requestId: 'req-draft-order',
        revisionId: 82,
        order: createDraftOrder(),
        nodes: [{ clientKey: 'detail-1', bazisNodeId: 101 }],
        idempotencyKey: 'draft-order-key-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.create'] },
    } satisfies Partial<ApiError>);

    const auditInsert = auditQuery.mock.calls.find(([text]) =>
      String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('),
    );
    expect(auditInsert).toBeDefined();
    const params = auditInsert?.[1] as unknown[];
    expect(params[2]).toBe('create_order_from_draft');
    expect(params.some((param) => String(param).includes('"action":"create_order_from_draft"'))).toBe(true);
    expect(repository.createOrderFromDraft).not.toHaveBeenCalled();
  });

  it('delegates createOrderFromDraft when bazis.manage and orders.create are present', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });

    const result = await service.createOrderFromDraft({
      currentUser: bazisOrderCreator(),
      requestId: 'req-draft-order',
      revisionId: 82,
      order: createDraftOrder(),
      nodes: [{ clientKey: 'detail-1', bazisNodeId: 101 }],
      idempotencyKey: 'draft-order-key-1',
    });

    expect(repository.createOrderFromDraft).toHaveBeenCalledWith({
      currentUser: bazisOrderCreator(),
      requestId: 'req-draft-order',
      revisionId: 82,
      order: createDraftOrder(),
      nodes: [{ clientKey: 'detail-1', bazisNodeId: 101 }],
      idempotencyKey: 'draft-order-key-1',
    });
    expect(result.orderId).toBe(1);
  });

  it('requires bazis.manage for addToOrder and writes denied-audit', async () => {
    const repository = createRepository();
    const auditQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ audit_id: 'aud-denied-add-to-order' }], rowCount: 1 });
    const service = new BazisService({
      repository,
      auditDatabase: { query: auditQuery },
    });

    await expect(
      service.addToOrder({
        currentUser: viewerUser(),
        requestId: 'req-add-to-order',
        revisionId: 82,
        orderId: 9001,
        adds: [101],
        replaces: [],
        skips: [],
        idempotencyKey: 'add-to-order-key-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['bazis.manage'] },
    } satisfies Partial<ApiError>);

    const auditInsert = auditQuery.mock.calls.find(([text]) =>
      String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('),
    );
    expect(auditInsert).toBeDefined();
    const params = auditInsert?.[1] as unknown[];
    expect(params[2]).toBe('add_to_order');
    expect(params.some((param) => String(param).includes('"action":"add_to_order"'))).toBe(true);
    expect(repository.addToOrder).not.toHaveBeenCalled();
  });

  it('requires orders.update for addToOrder after bazis.manage and writes denied-audit', async () => {
    const repository = createRepository();
    const auditQuery = vi
      .fn()
      .mockResolvedValue({ rows: [{ audit_id: 'aud-denied-orders-update' }], rowCount: 1 });
    const service = new BazisService({
      repository,
      auditDatabase: { query: auditQuery },
    });

    await expect(
      service.addToOrder({
        currentUser: bazisManager(),
        requestId: 'req-add-to-order',
        revisionId: 82,
        orderId: 9001,
        adds: [101],
        replaces: [],
        skips: [],
        idempotencyKey: 'add-to-order-key-1',
      }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.update'] },
    } satisfies Partial<ApiError>);

    const auditInsert = auditQuery.mock.calls.find(([text]) =>
      String(text).replace(/\s+/g, ' ').includes('INSERT INTO audit_log ('),
    );
    expect(auditInsert).toBeDefined();
    const params = auditInsert?.[1] as unknown[];
    expect(params[2]).toBe('add_to_order');
    expect(params.some((param) => String(param).includes('"action":"add_to_order"'))).toBe(true);
    expect(repository.addToOrder).not.toHaveBeenCalled();
  });
});

function createRepository(overrides: Partial<BazisRepositoryPort> = {}) {
  return {
    importRevision: vi.fn().mockResolvedValue({
      bazisProject: { bazisProjectId: 1, projectId: 12, name: 'Проект' },
      revision: { bazisRevisionId: 5, revisionNo: 2, xmlSha256: 'sha', summary: {} },
      unmappedMaterials: [],
      warnings: [],
      requestId: 'req-import',
    }),
    recordFailedImport: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue({
      bazisProjectId: 1,
      projectId: 1,
      projectName: 'ERP Проект',
      name: 'Проект',
      revisionsCount: 0,
      lastRevisionNo: null,
      lastImportedAt: null,
      bazisOrderNo: null,
      designEngineerId: null,
      designEngineerName: null,
      designEngineerXmlName: null,
      designEngineerSource: null,
      linkedOrderIds: [],
      linkedOrders: [],
      revisions: [],
    }),
    getTreeChildren: vi.fn().mockResolvedValue([]),
    listAllTreeNodes: vi.fn().mockResolvedValue([]),
    getRevisionEstimate: vi.fn().mockResolvedValue({ materials: [], operations: [] }),
    getNodeCard: vi.fn().mockResolvedValue({
      bazisNodeId: 555,
      revisionId: 82,
      bazisProjectId: 1,
      projectId: 1,
      revisionNo: 2,
      parentNodeId: null,
      seq: 1,
      nodeKind: 'detail',
      objectType: 'Шкаф',
      name: 'Узел',
      detailCode: null,
      position: null,
      designation: null,
      quantity: 1,
      cumulativeQuantity: 1,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      thicknessMm: null,
      price: null,
      isRectangular: null,
      textureOrientation: null,
      mainMaterialName: null,
      notes: null,
      childrenCount: 0,
      rawJson: {},
      orderLinks: [],
    }),
    searchNodes: vi.fn().mockResolvedValue({
      items: [],
      totalMatched: 0,
    }),
    getMaterialsSummary: vi.fn().mockResolvedValue({
      summary: {},
      panelsByMaterial: [],
      hardwareByName: [],
      edgesByName: [],
      filmsByName: [],
    }),
    listRevisionOrders: vi.fn().mockResolvedValue([]),
    listMaterialMappings: vi.fn().mockResolvedValue([]),
    upsertMaterialMappings: vi.fn().mockResolvedValue([]),
    buildOrderDraft: vi.fn().mockResolvedValue({
      revisionId: 1,
      projectId: 12,
      clientId: 2,
      clientName: 'Client',
      bazisProjectName: 'Проект',
      bazisOrderNo: '1457',
      details: [],
      duplicates: [],
    }),
    exportCutXls: vi.fn().mockResolvedValue({
      bytes: Buffer.from('xls'),
      bazisProjectId: 1,
      bazisProjectName: 'Проект',
      revisionId: 82,
      positionCount: 2,
      quantity: 3,
    }),
    createOrderFromDraft: vi.fn().mockResolvedValue({
      orderId: 1,
      orderName: 'Order',
      detailsCreated: 1,
      mappedNodes: 1,
      requestId: 'req-order',
    }),
    createOrderFromRevision: vi.fn().mockResolvedValue({
      orderId: 1,
      orderName: 'Order',
      detailsCreated: 0,
      mappedNodes: 0,
      requestId: 'req-order',
    }),
    addToOrder: vi.fn().mockResolvedValue({
      orderId: 9001,
      detailsAdded: 1,
      detailsReplaced: 0,
      requestId: 'req-add-to-order',
    }),
    setNodeNotes: vi.fn().mockResolvedValue({
      bazisNodeId: 1,
      notes: null,
    }),
    renameProject: vi.fn().mockResolvedValue({
      bazisProjectId: 41,
      projectId: 77,
      name: '1485',
    }),
    setProjectDesignEngineer: vi.fn().mockResolvedValue({
      bazisProjectId: 41,
      designEngineerId: 10,
      designEngineerName: 'Тапен Жамит',
      designEngineerXmlName: 'Тапен Ж.К',
      designEngineerSource: 'manual',
    }),
    deleteProject: vi.fn().mockResolvedValue({
      bazisProjectId: 41,
      projectId: 77,
      name: 'Шкаф Nova',
      revisionsDeleted: 2,
      nodesDeleted: 639,
    }),
    ...overrides,
  };
}

function createService(repository: BazisRepositoryPort = createRepository()): BazisService {
  return new BazisService({ repository });
}

async function writeFixtureFile(dir: string, name: string, contents: string): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

function bazisManager(): CurrentUser {
  return {
    id: '10',
    username: 'bazis-manager',
    role: 'manager',
    roleId: 1,
    permissions: ['bazis.manage', 'bazis.view'],
  };
}

function viewerUser(): CurrentUser {
  return {
    id: '11',
    username: 'bazis-viewer',
    role: 'manager',
    roleId: 1,
    permissions: ['bazis.view'],
  };
}

function bazisCutViewer(): CurrentUser {
  return {
    id: '15',
    username: 'bazis-cut-viewer',
    role: 'manager',
    roleId: 1,
    permissions: ['bazis.view', 'cut.view'],
  };
}

function cutOnlyUser(): CurrentUser {
  return {
    id: '16',
    username: 'cut-only',
    role: 'manager',
    roleId: 1,
    permissions: ['cut.view'],
  };
}

function managerUser(): CurrentUser {
  return {
    id: '12',
    username: 'manager',
    role: 'manager',
    roleId: 1,
    permissions: [],
  };
}

function ordersUpdaterUser(): CurrentUser {
  return {
    id: '13',
    username: 'order-updater',
    role: 'manager',
    roleId: 1,
    permissions: ['bazis.view', 'orders.update'],
  };
}

function bazisOrderCreator(): CurrentUser {
  return {
    id: '14',
    username: 'bazis-order-creator',
    role: 'manager',
    roleId: 1,
    permissions: ['bazis.manage', 'bazis.view', 'orders.create'],
  };
}

function createDraftOrder() {
  return {
    header: {
      orderName: 'Черновик',
      clientId: 2,
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
    idempotencyKey: 'nested-order-key',
  };
}
