import type { CurrentUser } from '../../../permissions/current-user';
import type { SaveOrderDto } from '../../orders/dto/save-order.dto';
import type { ParsedBazisRevision } from './bazis-xml-parser';
import type {
  BazisAddToOrderResponseDto,
  BazisAddToOrderPairDto,
  BazisImportResponseDto,
  CreateOrderFromDraftNodeDto,
  BazisProjectDeleteResponseDto,
  BazisNodeCardDto,
  BazisNodeNotesDto,
  BazisOrderDraftResponseDto,
  BazisNodeSearchResponseDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
  BazisProjectNameDto,
  BazisRevisionMaterialsSummaryDto,
  BazisRevisionEstimateDto,
  BazisRevisionOrderDto,
  BazisTreeNodeDto,
  CreateOrderFromRevisionResponseDto,
  MaterialMappingDto,
  UpsertMaterialMappingDto,
} from '../dto/bazis.dto';

export interface ImportRevisionCommand {
  currentUser: CurrentUser;
  requestId?: string;
  projectId: number | null;
  bazisProjectId: number | null;
  fileName: string;
  fileSize: number;
  xmlSha256: string;
  rawXmlGzip: Buffer;
  parsed: ParsedBazisRevision;
}

export interface ImportXmlInput {
  currentUser: CurrentUser;
  requestId?: string;
  projectId: number | null;
  bazisProjectId: number | null;
  fileName: string;
  filePath: string;
}

export interface CreateOrderFromRevisionCommand {
  currentUser: CurrentUser;
  requestId?: string;
  revisionId: number;
  clientId: number;
  orderName: string;
  orderStatusId: number;
  selectedNodeIds: number[];
  idempotencyKey: string;
}

export interface BuildOrderDraftCommand {
  currentUser: CurrentUser;
  requestId?: string;
  revisionId: number;
  selectedNodeIds: number[];
  targetOrderId?: number | null;
}

export interface ExportBazisCutXlsCommand {
  currentUser: CurrentUser;
  requestId?: string;
  revisionId: number;
  selectedNodeIds: number[];
}

export interface BazisCutXlsExportResult {
  bytes: Buffer;
  bazisProjectId: number;
  bazisProjectName: string;
  revisionId: number;
  positionCount: number;
  quantity: number;
}

export interface CreateOrderFromDraftCommand {
  currentUser: CurrentUser;
  requestId?: string;
  revisionId: number;
  order: SaveOrderDto;
  nodes: CreateOrderFromDraftNodeDto[];
  idempotencyKey: string;
}

export interface AddToOrderCommand {
  currentUser: CurrentUser;
  requestId?: string;
  revisionId: number;
  orderId: number;
  adds: number[];
  replaces: BazisAddToOrderPairDto[];
  skips: BazisAddToOrderPairDto[];
  idempotencyKey: string;
}

export interface DeleteBazisProjectInput {
  currentUser: CurrentUser;
  requestId?: string;
  bazisProjectId: number;
}

export interface RenameBazisProjectInput {
  currentUser: CurrentUser;
  requestId?: string;
  bazisProjectId: number;
  name: string;
}

export interface SetNodeNotesInput {
  currentUser: CurrentUser;
  requestId?: string;
  nodeId: number;
  notes: string | null;
}

export interface BazisRepositoryPort {
  importRevision(command: ImportRevisionCommand): Promise<BazisImportResponseDto>;
  recordFailedImport(input: {
    currentUser: CurrentUser;
    requestId?: string;
    fileName: string;
    xmlSha256: string | null;
    errorMessage: string;
  }): Promise<void>;
  listProjects(filter: { projectId?: number }): Promise<BazisProjectListItemDto[]>;
  getProject(bazisProjectId: number): Promise<BazisProjectCardDto>;
  renameProject(input: RenameBazisProjectInput): Promise<BazisProjectNameDto>;
  getTreeChildren(revisionId: number, parentNodeId: number | null): Promise<BazisTreeNodeDto[]>;
  listAllTreeNodes(revisionId: number): Promise<BazisTreeNodeDto[]>;
  listMaterialMappings(names?: string[]): Promise<MaterialMappingDto[]>;
  upsertMaterialMappings(
    currentUser: CurrentUser,
    requestId: string | undefined,
    items: UpsertMaterialMappingDto[],
  ): Promise<MaterialMappingDto[]>;
  buildOrderDraft(command: BuildOrderDraftCommand): Promise<BazisOrderDraftResponseDto>;
  exportCutXls(command: ExportBazisCutXlsCommand): Promise<BazisCutXlsExportResult>;
  createOrderFromDraft(command: CreateOrderFromDraftCommand): Promise<CreateOrderFromRevisionResponseDto>;
  createOrderFromRevision(
    command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto>;
  addToOrder(command: AddToOrderCommand): Promise<BazisAddToOrderResponseDto>;
  getNodeCard(nodeId: number): Promise<BazisNodeCardDto>;
  searchNodes(input: {
    revisionId: number;
    q: string | null;
    objectType: string | null;
    limit: number;
  }): Promise<BazisNodeSearchResponseDto>;
  getMaterialsSummary(revisionId: number): Promise<BazisRevisionMaterialsSummaryDto>;
  listRevisionOrders(revisionId: number): Promise<BazisRevisionOrderDto[]>;
  getRevisionEstimate(revisionId: number): Promise<BazisRevisionEstimateDto>;
  deleteProject(input: DeleteBazisProjectInput): Promise<BazisProjectDeleteResponseDto>;
  setNodeNotes(input: SetNodeNotesInput): Promise<BazisNodeNotesDto>;
}
