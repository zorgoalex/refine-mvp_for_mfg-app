import { ApiError } from '../../../common/errors/api-error';
import type {
  ListMdfBathDuplicatesCommand,
  MdfBathDuplicateRepositoryPort,
  ResolveMdfBathDuplicateCommand,
} from '../application/mdf-bath-duplicate.types';
import type { MdfBathDuplicatesResponseDto, ResolveMdfBathDuplicateResponseDto } from '../dto/mdf-bath-duplicate.dto';

export class UnavailableMdfBathDuplicateRepository implements MdfBathDuplicateRepositoryPort {
  async list(_command: ListMdfBathDuplicatesCommand): Promise<MdfBathDuplicatesResponseDto> {
    throw unavailable();
  }

  async resolve(_command: ResolveMdfBathDuplicateCommand): Promise<ResolveMdfBathDuplicateResponseDto> {
    throw unavailable();
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'MDF bath duplicates adapter is not configured', {
    feature: 'mdf_bath_duplicates',
    adapter: 'mdf_bath_duplicate_repository',
  });
}
