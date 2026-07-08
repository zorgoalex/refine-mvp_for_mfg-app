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

  it('streams sha256 and gzip from disk, parses once, and delegates importRevision', async () => {
    const repository = createRepository();
    const service = new BazisService({ repository });
    const xml = await readFile(
      'backend/src/modules/bazis/application/__fixtures__/bazis-sample.xml',
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
      name: 'Проект',
      revisionsCount: 0,
      lastRevisionNo: null,
      lastImportedAt: null,
      linkedOrderIds: [],
      revisions: [],
    }),
    getTreeChildren: vi.fn().mockResolvedValue([]),
    listMaterialMappings: vi.fn().mockResolvedValue([]),
    upsertMaterialMappings: vi.fn().mockResolvedValue([]),
    createOrderFromRevision: vi.fn().mockResolvedValue({
      orderId: 1,
      orderName: 'Order',
      detailsCreated: 0,
      mappedNodes: 0,
      requestId: 'req-order',
    }),
    ...overrides,
  };
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

function managerUser(): CurrentUser {
  return {
    id: '12',
    username: 'manager',
    role: 'manager',
    roleId: 1,
    permissions: [],
  };
}
