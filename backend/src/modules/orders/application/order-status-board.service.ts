import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import { ROLE_POLICIES } from '../../../permissions/policies/role-policies';
import type { OrderStatusBoardResponseDto } from '../dto/order-status-board.dto';
import type {
  GetOrderStatusBoardCommand,
  OrderStatusBoardRepositoryPort,
} from './order-status-board.types';

export interface OrderStatusBoardServicePorts {
  boards: OrderStatusBoardRepositoryPort;
  permissions?: PermissionsService;
}

export class OrderStatusBoardService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: OrderStatusBoardServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async get(command: GetOrderStatusBoardCommand): Promise<OrderStatusBoardResponseDto> {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра доски', {
        requiredPermissions: ['orders.view'],
      });
    }
    if (
      command.query.board === 'production' &&
      ROLE_POLICIES[command.currentUser.role].productionTasks.view === 'none'
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра доски производства', {
        requiredPermissions: ['productionTasks.view'],
      });
    }

    const response = await this.ports.boards.getBoard(command);
    if (this.permissions.canUser(command.currentUser, 'orders.view_financials')) {
      return { ...response, financialsVisible: true };
    }

    return {
      ...response,
      financialsVisible: false,
      columns: response.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({
          ...card,
          paymentStatusId: null,
          paymentStatusName: null,
          finalAmount: null,
          paidAmount: null,
          debtAmount: null,
        })),
      })),
    };
  }
}
