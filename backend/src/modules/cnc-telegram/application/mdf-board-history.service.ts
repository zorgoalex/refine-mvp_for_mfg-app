import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GetMdfBoardHistoryCommand,
  MdfBoardHistoryRepositoryPort,
  SearchMdfBoardHistoryOrdersCommand,
} from './mdf-board-history.types';

export class MdfBoardHistoryService {
  private readonly permissions: PermissionsService;

  constructor(
    private readonly repository: MdfBoardHistoryRepositoryPort,
    permissions?: PermissionsService,
  ) {
    this.permissions = permissions ?? new PermissionsService();
  }

  searchOrders(command: SearchMdfBoardHistoryOrdersCommand) {
    this.assertCanView(command.currentUser);
    return this.repository.searchOrders(command);
  }

  getHistory(command: GetMdfBoardHistoryCommand) {
    this.assertCanView(command.currentUser);
    return this.repository.getHistory(command);
  }

  private assertCanView(currentUser: SearchMdfBoardHistoryOrdersCommand['currentUser']): void {
    if (!this.permissions.canUser(currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра истории МДФ-доски', {
        requiredPermissions: ['orders.view'],
      });
    }
  }
}
