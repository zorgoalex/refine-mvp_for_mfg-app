import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
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
  type BazisNodeCardDto,
  type BazisNodeSearchResponseDto,
  type BazisProjectCardDto,
  type BazisProjectListItemDto,
  type BazisRevisionMaterialsSummaryDto,
  type BazisRevisionOrderDto,
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
  /** Optional client for best-effort denied-audit rows (absent in unit tests without DB). */
  auditDatabase?: DatabaseClient;
}

export class BazisService {
  private readonly permissions: PermissionsService;
  private importInFlight = false;

  constructor(private readonly ports: BazisServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async importXml(input: ImportXmlInput): Promise<BazisImportResponseDto> {
    await this.requirePermission(input.currentUser, 'bazis.manage', 'import_xml', input.requestId);

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
    await this.requirePermission(currentUser, 'bazis.view', 'list_projects');
    return this.ports.repository.listProjects(filter);
  }

  async getProject(currentUser: CurrentUser, id: number): Promise<BazisProjectCardDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_project');
    return this.ports.repository.getProject(id);
  }

  async getTree(
    currentUser: CurrentUser,
    revisionId: number,
    parentNodeId: number | null,
  ): Promise<BazisTreeNodeDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_tree');
    return this.ports.repository.getTreeChildren(revisionId, parentNodeId);
  }

  async getFullTree(currentUser: CurrentUser, revisionId: number): Promise<BazisTreeNodeDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_full_tree');
    return this.ports.repository.listAllTreeNodes(revisionId);
  }

  async getNodeCard(currentUser: CurrentUser, nodeId: number): Promise<BazisNodeCardDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_node_card');
    return this.ports.repository.getNodeCard(nodeId);
  }

  async searchNodes(
    currentUser: CurrentUser,
    revisionId: number,
    input: { q: string | null; objectType: string | null; limit: number },
  ): Promise<BazisNodeSearchResponseDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'search_nodes');
    return this.ports.repository.searchNodes({ revisionId, ...input });
  }

  async getMaterialsSummary(
    currentUser: CurrentUser,
    revisionId: number,
  ): Promise<BazisRevisionMaterialsSummaryDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_materials_summary');
    return this.ports.repository.getMaterialsSummary(revisionId);
  }

  async listRevisionOrders(
    currentUser: CurrentUser,
    revisionId: number,
  ): Promise<BazisRevisionOrderDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'list_revision_orders');
    return this.ports.repository.listRevisionOrders(revisionId);
  }

  async listMaterialMappings(
    currentUser: CurrentUser,
    names?: string[],
  ): Promise<MaterialMappingDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'list_material_mappings');
    return this.ports.repository.listMaterialMappings(names);
  }

  async upsertMaterialMappings(
    currentUser: CurrentUser,
    requestId: string | undefined,
    items: UpsertMaterialMappingDto[],
  ): Promise<MaterialMappingDto[]> {
    await this.requirePermission(currentUser, 'bazis.manage', 'upsert_material_mappings', requestId);
    return this.ports.repository.upsertMaterialMappings(currentUser, requestId, items);
  }

  async createOrderFromRevision(
    command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    await this.requirePermission(command.currentUser, 'bazis.manage', 'create_order', command.requestId);
    return this.ports.repository.createOrderFromRevision(command);
  }

  private async requirePermission(
    currentUser: CurrentUser,
    permission: PermissionName,
    action: string,
    requestId?: string,
  ): Promise<void> {
    if (this.permissions.canUser(currentUser, permission)) {
      return;
    }
    if (this.ports.auditDatabase) {
      // Best-effort denied trail: forensics for privileged workflow (Critic R1-3);
      // audit failure must not mask the 403.
      try {
        await auditService.recordDenied(this.ports.auditDatabase, {
          event: 'bazis.permission_denied',
          entityType: 'bazis',
          entityId: action,
          actorUserId: currentUser.id,
          actorUsername: currentUser.username,
          actorRole: currentUser.role,
          requestId: requestId ?? 'bazis-command',
          source: 'backend-bazis-command',
          reason: 'permission_denied',
          requiredPermissions: [permission],
          metadata: { action },
        });
      } catch {
        /* best-effort */
      }
    }
    throw new ApiError(
      403,
      'PERMISSION_DENIED',
      'Недостаточно прав для работы с Базис-импортом',
      { requiredPermissions: [permission] },
    );
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
