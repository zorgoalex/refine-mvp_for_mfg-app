import type {
  AddToOrderCommand,
  BazisCutXlsExportResult,
  BazisRepositoryPort,
  BuildOrderDraftCommand,
  CreateOrderFromDraftCommand,
  CreateOrderFromRevisionCommand,
  DeleteBazisProjectInput,
  ExportBazisCutXlsCommand,
  ImportRevisionCommand,
  RenameBazisProjectInput,
  SetNodeNotesInput,
} from '../application/bazis.types';
import type {
  BazisAddToOrderResponseDto,
  BazisOrderDraftResponseDto,
  BazisRevisionEstimateDto,
  BazisImportResponseDto,
  BazisProjectDeleteResponseDto,
  BazisNodeCardDto,
  BazisNodeNotesDto,
  BazisNodeSearchResponseDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
  BazisProjectNameDto,
  BazisRevisionMaterialsSummaryDto,
  BazisRevisionOrderDto,
  BazisTreeNodeDto,
  CreateOrderFromRevisionResponseDto,
  MaterialMappingDto,
  UpsertMaterialMappingDto,
} from '../dto/bazis.dto';
import { BazisDatabaseUnavailableError } from '../errors/bazis.errors';
import type { CurrentUser } from '../../../permissions/current-user';

const unavailable = <T>(): Promise<T> => Promise.reject(new BazisDatabaseUnavailableError());

export class UnavailableBazisRepository implements BazisRepositoryPort {
  importRevision(_command: ImportRevisionCommand): Promise<BazisImportResponseDto> {
    return unavailable();
  }

  recordFailedImport(_input: {
    currentUser: CurrentUser;
    requestId?: string;
    fileName: string;
    xmlSha256: string | null;
    errorMessage: string;
  }): Promise<void> {
    return unavailable();
  }

  listProjects(_filter: { projectId?: number }): Promise<BazisProjectListItemDto[]> {
    return unavailable();
  }

  getProject(_bazisProjectId: number): Promise<BazisProjectCardDto> {
    return unavailable();
  }

  renameProject(_input: RenameBazisProjectInput): Promise<BazisProjectNameDto> {
    return unavailable();
  }

  getTreeChildren(_revisionId: number, _parentNodeId: number | null): Promise<BazisTreeNodeDto[]> {
    return unavailable();
  }

  listAllTreeNodes(_revisionId: number): Promise<BazisTreeNodeDto[]> {
    return unavailable();
  }

  getRevisionEstimate(_revisionId: number): Promise<BazisRevisionEstimateDto> {
    return unavailable();
  }

  listMaterialMappings(_names?: string[]): Promise<MaterialMappingDto[]> {
    return unavailable();
  }

  upsertMaterialMappings(
    _currentUser: CurrentUser,
    _requestId: string | undefined,
    _items: UpsertMaterialMappingDto[],
  ): Promise<MaterialMappingDto[]> {
    return unavailable();
  }

  buildOrderDraft(_command: BuildOrderDraftCommand): Promise<BazisOrderDraftResponseDto> {
    return unavailable();
  }

  exportCutXls(_command: ExportBazisCutXlsCommand): Promise<BazisCutXlsExportResult> {
    return unavailable();
  }

  createOrderFromRevision(
    _command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    return unavailable();
  }

  createOrderFromDraft(
    _command: CreateOrderFromDraftCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    return unavailable();
  }

  addToOrder(_command: AddToOrderCommand): Promise<BazisAddToOrderResponseDto> {
    return unavailable();
  }

  getNodeCard(_nodeId: number): Promise<BazisNodeCardDto> {
    return unavailable();
  }

  searchNodes(_input: {
    revisionId: number;
    q: string | null;
    objectType: string | null;
    limit: number;
  }): Promise<BazisNodeSearchResponseDto> {
    return unavailable();
  }

  getMaterialsSummary(_revisionId: number): Promise<BazisRevisionMaterialsSummaryDto> {
    return unavailable();
  }

  listRevisionOrders(_revisionId: number): Promise<BazisRevisionOrderDto[]> {
    return unavailable();
  }

  deleteProject(_input: DeleteBazisProjectInput): Promise<BazisProjectDeleteResponseDto> {
    return unavailable();
  }

  setNodeNotes(_input: SetNodeNotesInput): Promise<BazisNodeNotesDto> {
    return unavailable();
  }
}
