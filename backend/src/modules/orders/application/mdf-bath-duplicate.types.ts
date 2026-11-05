import type { CurrentUser } from '../../../permissions/current-user';
import type {
  MdfBathDuplicateActionDto,
  MdfBathDuplicatesResponseDto,
  ResolveMdfBathDuplicateResponseDto,
} from '../dto/mdf-bath-duplicate.dto';

export interface ResolveMdfBathDuplicateCommand {
  currentUser: CurrentUser;
  bathCardId: string;
  otherBathCardId: string;
  action: MdfBathDuplicateActionDto;
  expectedDigest: string;
  idempotencyKey: string;
  requestId?: string;
}

export interface ListMdfBathDuplicatesCommand {
  currentUser: CurrentUser;
  bathCardIds: string[];
  requestId?: string;
}

export interface MdfBathDuplicateRepositoryPort {
  list(command: ListMdfBathDuplicatesCommand): Promise<MdfBathDuplicatesResponseDto>;
  resolve(command: ResolveMdfBathDuplicateCommand): Promise<ResolveMdfBathDuplicateResponseDto>;
}
