import type { CurrentUser } from '../../../permissions/current-user';
import type { ParsedBazisRevision } from './bazis-xml-parser';
import type {
  BazisImportResponseDto,
  BazisProjectDeleteResponseDto,
  BazisNodeCardDto,
  BazisOrderDraftResponseDto,
  BazisNodeSearchResponseDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
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

export interface DeleteBazisProjectInput {
  currentUser: CurrentUser;
  requestId?: string;
  bazisProjectId: number;
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
  getTreeChildren(revisionId: number, parentNodeId: number | null): Promise<BazisTreeNodeDto[]>;
  listAllTreeNodes(revisionId: number): Promise<BazisTreeNodeDto[]>;
  listMaterialMappings(names?: string[]): Promise<MaterialMappingDto[]>;
  upsertMaterialMappings(
    currentUser: CurrentUser,
    requestId: string | undefined,
    items: UpsertMaterialMappingDto[],
  ): Promise<MaterialMappingDto[]>;
  buildOrderDraft(command: BuildOrderDraftCommand): Promise<BazisOrderDraftResponseDto>;
  createOrderFromRevision(
    command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto>;
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
}
