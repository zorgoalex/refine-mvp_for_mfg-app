import { readableOrderIds } from '../../../permissions/policies/order-read-visibility';
import { humanNameError } from '../../../shared/human-name';
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
  AddToOrderCommand,
  BazisRepositoryPort,
  BuildOrderDraftCommand,
  CreateOrderFromDraftCommand,
  CreateOrderFromRevisionCommand,
  ExportBazisCutXlsCommand,
  ImportXmlInput,
} from './bazis.types';
import {
  type BazisAddToOrderResponseDto,
  type BazisImportResponseDto,
  type BazisNodeCardDto,
  type BazisNodeNotesDto,
  type BazisOrderDraftResponseDto,
  type BazisNodeSearchResponseDto,
  type BazisProjectCardDto,
  type BazisProjectDeleteResponseDto,
  type BazisProjectDesignEngineerDto,
  type BazisProjectListItemDto,
  type BazisProjectNameDto,
  type BazisRevisionMaterialsSummaryDto,
  type BazisRevisionEstimateDto,
  type BazisRevisionOrderDto,
  type BazisTreeNodeDto,
  type CreateOrderFromRevisionResponseDto,
  type MaterialMappingDto,
  type UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import { BazisImportBusyError, BazisNodeNotesTooLongError, BazisParseFailedError } from '../errors/bazis.errors';
import { BazisXmlParseError, parseBazisXml } from './bazis-xml-parser';

export interface BazisServicePorts {
  repository: BazisRepositoryPort;
  permissions?: PermissionsService;
  /** Optional client for best-effort denied-audit rows (absent in unit tests without DB). */
  auditDatabase?: DatabaseClient;
}

const NODE_NOTES_MAX_LENGTH = 2000;


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
        const text = await readFile(input.filePath);
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
          ...(input.cards ? { cards: input.cards } : {}),
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
    filter: { projectId?: number; dowelingOrderId?: number },
  ): Promise<BazisProjectListItemDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'list_projects');
    // The XML of a card only for a reader of cards (the card itself is checked per row below).
    if (filter.dowelingOrderId != null && !currentUser.permissions.includes('doweling.view')) return [];
    const projects = (await this.ports.repository.listProjects(filter))
      .filter((project) => filter.dowelingOrderId == null || project.card?.dowelingOrderId === filter.dowelingOrderId);
    const readable = await this.readable(currentUser, projects.flatMap(projectOrderIds));
    const shown = projects.map((project) => withReadableOrders(project, readable, currentUser));
    // Filtered by a card the reader may not read: nothing (not even that XML projects exist).
    return filter.dowelingOrderId != null && shown.some((project) => project.card === null) ? [] : shown;
  }

  async getProject(currentUser: CurrentUser, id: number): Promise<BazisProjectCardDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_project');
    const project = await this.ports.repository.getProject(id);
    const readable = await this.readable(currentUser, projectOrderIds(project));
    return withReadableOrders(project, readable, currentUser);
  }

  async renameProject(
    currentUser: CurrentUser,
    requestId: string | undefined,
    bazisProjectId: number,
    rawName: string,
  ): Promise<BazisProjectNameDto> {
    await this.requirePermission(currentUser, 'bazis.manage', 'rename_project', requestId);
    const name = rawName.trim();
    if (humanNameError(rawName, Number.MAX_SAFE_INTEGER)) {
      throw new ApiError(
        422,
        'VALIDATION_ERROR',
        humanNameError(rawName, Number.MAX_SAFE_INTEGER)!,
        { field: 'name' },
      );
    }
    return this.ports.repository.renameProject({
      currentUser,
      requestId,
      bazisProjectId,
      name,
    });
  }

  async setProjectDesignEngineer(
    currentUser: CurrentUser,
    requestId: string | undefined,
    bazisProjectId: number,
    designEngineerId: number | null,
  ): Promise<BazisProjectDesignEngineerDto> {
    await this.requirePermission(currentUser, 'bazis.manage', 'set_project_design_engineer', requestId);
    return this.ports.repository.setProjectDesignEngineer({
      currentUser,
      requestId,
      bazisProjectId,
      designEngineerId,
    });
  }

  async getTree(
    currentUser: CurrentUser,
    revisionId: number,
    parentNodeId: number | null,
  ): Promise<BazisTreeNodeDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_tree');
    return this.filterTreeNodes(currentUser, await this.ports.repository.getTreeChildren(revisionId, parentNodeId));
  }

  async getFullTree(currentUser: CurrentUser, revisionId: number): Promise<BazisTreeNodeDto[]> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_full_tree');
    return this.filterTreeNodes(currentUser, await this.ports.repository.listAllTreeNodes(revisionId));
  }

  async getRevisionEstimate(currentUser: CurrentUser, revisionId: number): Promise<BazisRevisionEstimateDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_revision_estimate');
    return this.ports.repository.getRevisionEstimate(revisionId);
  }

  async getNodeCard(currentUser: CurrentUser, nodeId: number): Promise<BazisNodeCardDto> {
    await this.requirePermission(currentUser, 'bazis.view', 'get_node_card');
    const card = await this.ports.repository.getNodeCard(nodeId);
    const readable = await this.readable(currentUser, card.orderLinks.map((link) => link.orderId));
    return readable ? { ...card, orderLinks: card.orderLinks.filter((link) => readable.has(link.orderId)) } : card;
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
    const orders = await this.ports.repository.listRevisionOrders(revisionId);
    const readable = await this.readable(currentUser, orders.map((order) => order.orderId));
    return readable ? orders.filter((order) => readable.has(order.orderId)) : orders;
  }

  /**
   * Orders linked to Bazis objects are shown only within the reader's order read visibility (access groups 0A.4):
   * the Bazis data itself stays visible, references to other people's orders are dropped. `null` = unrestricted.
   */
  private async readable(currentUser: CurrentUser, orderIds: number[]): Promise<Set<number> | null> {
    return this.ports.auditDatabase ? readableOrderIds(this.ports.auditDatabase, currentUser, orderIds) : null;
  }

  private async filterTreeNodes(currentUser: CurrentUser, nodes: BazisTreeNodeDto[]): Promise<BazisTreeNodeDto[]> {
    const readable = await this.readable(currentUser, nodes.flatMap((node) => [...node.orders.map((order) => order.orderId), ...node.orderIds]));
    if (!readable) return nodes;
    return nodes.map((node) => {
      const orders = node.orders.filter((order) => readable.has(order.orderId));
      return { ...node, orders, orderIds: orders.map((order) => order.orderId) };
    });
  }

  async deleteProject(
    currentUser: CurrentUser,
    requestId: string | undefined,
    bazisProjectId: number,
  ): Promise<BazisProjectDeleteResponseDto> {
    await this.requirePermission(currentUser, 'bazis.manage', 'delete_project', requestId);
    return this.ports.repository.deleteProject({ currentUser, requestId, bazisProjectId });
  }

  async setNodeNotes(
    currentUser: CurrentUser,
    requestId: string | undefined,
    nodeId: number,
    rawNotes: string | null,
  ): Promise<BazisNodeNotesDto> {
    await this.requirePermission(currentUser, 'bazis.manage', 'set_node_notes', requestId);
    const trimmed = rawNotes?.trim() ?? '';
    const notes = trimmed === '' ? null : trimmed;
    if (notes != null && notes.length > NODE_NOTES_MAX_LENGTH) {
      throw new BazisNodeNotesTooLongError(NODE_NOTES_MAX_LENGTH);
    }
    return this.ports.repository.setNodeNotes({ currentUser, requestId, nodeId, notes });
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

  async createOrderFromDraft(
    command: CreateOrderFromDraftCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    await this.requirePermission(command.currentUser, 'bazis.manage', 'create_order_from_draft', command.requestId);
    await this.requirePermission(command.currentUser, 'orders.create', 'create_order_from_draft', command.requestId);
    return this.ports.repository.createOrderFromDraft(command);
  }

  async addToOrder(command: AddToOrderCommand): Promise<BazisAddToOrderResponseDto> {
    await this.requirePermission(command.currentUser, 'bazis.manage', 'add_to_order', command.requestId);
    await this.requirePermission(command.currentUser, 'orders.update', 'add_to_order', command.requestId);
    return this.ports.repository.addToOrder(command);
  }

  async buildOrderDraft(command: BuildOrderDraftCommand): Promise<BazisOrderDraftResponseDto> {
    await this.requirePermission(command.currentUser, 'bazis.view', 'order_draft', command.requestId);
    if (command.targetOrderId != null) {
      await this.requirePermission(command.currentUser, 'orders.update', 'order_draft', command.requestId);
    }
    return this.ports.repository.buildOrderDraft(command);
  }

  async exportCutXls(command: ExportBazisCutXlsCommand) {
    await this.requirePermission(command.currentUser, 'bazis.view', 'export_cut_xls', command.requestId);
    await this.requirePermission(command.currentUser, 'bazis.manage', 'export_cut_xls', command.requestId);
    return this.ports.repository.exportCutXls(command);
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

/** Every order id a Bazis project carries (both the references and the id list). */
function projectOrderIds(project: BazisProjectListItemDto): number[] {
  return [...project.linkedOrders.map((order) => order.orderId), ...project.linkedOrderIds, ...(project.card?.orderIds ?? [])];
}

/**
 * Both order fields filtered by one set of readable ids (access groups 0A.4, review R1); null — reads are unrestricted.
 * The card is given only to a reader of the card: doweling.view and every order of the card readable (the Hasura read
 * predicate of doweling orders); its order ids are not given out.
 */
function withReadableOrders<T extends BazisProjectListItemDto>(project: T, readable: Set<number> | null, user: CurrentUser): T {
  const cardReadable = project.card !== null
    && user.permissions.includes('doweling.view')
    && (readable === null || project.card.orderIds.every((id) => readable.has(id)));
  return {
    ...project,
    linkedOrders: readable ? project.linkedOrders.filter((order) => readable.has(order.orderId)) : project.linkedOrders,
    linkedOrderIds: readable ? project.linkedOrderIds.filter((id) => readable.has(id)) : project.linkedOrderIds,
    card: cardReadable && project.card ? { ...project.card, orderIds: [] } : null,
  };
}
