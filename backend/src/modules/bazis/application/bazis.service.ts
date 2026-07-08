import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { ApiError } from '../../../common/errors/api-error';
import type { PermissionName } from '../../../permissions/permissions';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  BazisRepositoryPort,
  CreateOrderFromRevisionCommand,
  ImportXmlInput,
} from './bazis.types';
import {
  type BazisImportResponseDto,
  type BazisProjectCardDto,
  type BazisProjectListItemDto,
  type BazisTreeNodeDto,
  type CreateOrderFromRevisionResponseDto,
  type MaterialMappingDto,
  type UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import { BazisImportBusyError, BazisParseFailedError } from '../errors/bazis.errors';
import { BazisXmlParseError, parseBazisXml } from './bazis-xml-parser';

export interface BazisServicePorts {
  repository: BazisRepositoryPort;
  permissions?: PermissionsService;
}

export class BazisService {
  private readonly permissions: PermissionsService;
  private importInFlight = false;

  constructor(private readonly ports: BazisServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async importXml(input: ImportXmlInput): Promise<BazisImportResponseDto> {
    this.requirePermission(input.currentUser, 'bazis.manage');

    if (this.importInFlight) {
      throw new BazisImportBusyError();
    }

    this.importInFlight = true;
    try {
      const fileInfo = await stat(input.filePath);
      const xmlSha256 = await hashFileSha256(input.filePath);
      const rawXmlGzip = await gzipFile(input.filePath);

      try {
        const text = await readFile(input.filePath, 'utf8');
        const parsed = parseBazisXml(text);
        return await this.ports.repository.importRevision({
          currentUser: input.currentUser,
          requestId: input.requestId,
          projectId: input.projectId,
          bazisProjectId: input.bazisProjectId,
          fileName: input.fileName,
          fileSize: fileInfo.size,
          xmlSha256,
          rawXmlGzip,
          parsed,
        });
      } catch (error) {
        if (error instanceof BazisXmlParseError) {
          await this.ports.repository.recordFailedImport({
            currentUser: input.currentUser,
            requestId: input.requestId,
            fileName: input.fileName,
            xmlSha256,
            errorMessage: error.message,
          });
          throw new BazisParseFailedError(error.message);
        }

        throw error;
      }
    } finally {
      this.importInFlight = false;
    }
  }

  async listProjects(
    currentUser: CurrentUser,
    filter: { projectId?: number },
  ): Promise<BazisProjectListItemDto[]> {
    this.requirePermission(currentUser, 'bazis.view');
    return this.ports.repository.listProjects(filter);
  }

  async getProject(currentUser: CurrentUser, id: number): Promise<BazisProjectCardDto> {
    this.requirePermission(currentUser, 'bazis.view');
    return this.ports.repository.getProject(id);
  }

  async getTree(
    currentUser: CurrentUser,
    revisionId: number,
    parentNodeId: number | null,
  ): Promise<BazisTreeNodeDto[]> {
    this.requirePermission(currentUser, 'bazis.view');
    return this.ports.repository.getTreeChildren(revisionId, parentNodeId);
  }

  async listMaterialMappings(
    currentUser: CurrentUser,
    names?: string[],
  ): Promise<MaterialMappingDto[]> {
    this.requirePermission(currentUser, 'bazis.view');
    return this.ports.repository.listMaterialMappings(names);
  }

  async upsertMaterialMappings(
    currentUser: CurrentUser,
    requestId: string | undefined,
    items: UpsertMaterialMappingDto[],
  ): Promise<MaterialMappingDto[]> {
    this.requirePermission(currentUser, 'bazis.manage');
    return this.ports.repository.upsertMaterialMappings(currentUser, requestId, items);
  }

  async createOrderFromRevision(
    command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    this.requirePermission(command.currentUser, 'bazis.manage');
    return this.ports.repository.createOrderFromRevision(command);
  }

  private requirePermission(currentUser: CurrentUser, permission: PermissionName): void {
    if (!this.permissions.canUser(currentUser, permission)) {
      throw new ApiError(
        403,
        'PERMISSION_DENIED',
        'Недостаточно прав для работы с Базис-импортом',
        { requiredPermissions: [permission] },
      );
    }
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(
    createReadStream(filePath),
    new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  return hash.digest('hex');
}

async function gzipFile(filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pipeline(
    createReadStream(filePath),
    createGzip(),
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    }),
  );
  return Buffer.concat(chunks);
}
