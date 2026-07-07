import type {
  BazisRepositoryPort,
  CreateOrderFromRevisionCommand,
  ImportRevisionCommand,
} from '../application/bazis.types';
import type {
  BazisImportResponseDto,
  BazisProjectCardDto,
  BazisProjectListItemDto,
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

  getTreeChildren(_revisionId: number, _parentNodeId: number | null): Promise<BazisTreeNodeDto[]> {
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

  createOrderFromRevision(
    _command: CreateOrderFromRevisionCommand,
  ): Promise<CreateOrderFromRevisionResponseDto> {
    return unavailable();
  }
}
