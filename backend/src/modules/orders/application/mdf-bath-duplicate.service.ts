import { ApiError } from '../../../common/errors/api-error';
import type { MdfBathDuplicatesResponseDto, ResolveMdfBathDuplicateResponseDto } from '../dto/mdf-bath-duplicate.dto';
import type {
  ListMdfBathDuplicatesCommand,
  MdfBathDuplicateRepositoryPort,
  ResolveMdfBathDuplicateCommand,
} from './mdf-bath-duplicate.types';

/** Same authority as the cut (user decision 30.10): literal `cut.manage` + `orders.view`; the repository adds the
 * order view scope over every owner of both baths. */
export const MDF_BATH_DUPLICATE_PERMISSIONS = ['cut.manage', 'orders.view'] as const;

export class MdfBathDuplicateService {
  constructor(private readonly ports: { duplicates: MdfBathDuplicateRepositoryPort }) {}

  /** Same read authority as the board (`orders.view`); the repository applies the order view scope. */
  async list(command: ListMdfBathDuplicatesCommand): Promise<MdfBathDuplicatesResponseDto> {
    if (!command.currentUser.permissions.includes('orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра МДФ-доски', {
        requiredPermissions: ['orders.view'],
      });
    }
    return this.ports.duplicates.list(command);
  }

  async resolve(command: ResolveMdfBathDuplicateCommand): Promise<ResolveMdfBathDuplicateResponseDto> {
    if (!MDF_BATH_DUPLICATE_PERMISSIONS.every(permission => command.currentUser.permissions.includes(permission))) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для разбора дубля ванн', {
        requiredPermissions: [...MDF_BATH_DUPLICATE_PERMISSIONS],
      });
    }
    return this.ports.duplicates.resolve(command);
  }
}
