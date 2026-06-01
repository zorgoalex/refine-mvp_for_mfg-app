import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type {
  OrderAuditListResponseDto,
  OrderDto,
  OrderListResponseDto,
} from '../dto/order.dto';
import { OrderNotFoundError } from '../errors/order.errors';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  GetOrderFormDataCommand,
  GetOrderAuditCommand,
  GetOrderByIdCommand,
  ListOrdersCommand,
  OrderReadRepositoryPort,
  OrderListSortBy,
} from './order-query.types';

const FINANCIAL_ORDER_SORT_FIELDS = new Set<OrderListSortBy>([
  'paymentStatusName',
  'finalAmount',
  'paidAmount',
  'debtAmount',
]);

export interface OrderQueryServicePorts {
  reader: OrderReadRepositoryPort;
  permissions?: OrderPermissionCheckerPort;
}

export class OrderQueryService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: OrderQueryServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(command: ListOrdersCommand): Promise<OrderListResponseDto> {
    this.requireViewPermission(command);

    if (!this.canViewFinancials(command)) {
      this.rejectFinancialListControls(command);
    }

    const response = await this.ports.reader.listOrders(command);

    if (this.canViewFinancials(command)) {
      return response;
    }

    return {
      ...response,
      data: response.data.map(maskOrderListItemFinancials),
    };
  }

  async getById(command: GetOrderByIdCommand): Promise<OrderDto> {
    this.requireViewPermission(command);

    const order = await this.ports.reader.getOrderById(command);

    if (!order) {
      throw new OrderNotFoundError(command.orderId);
    }

    return maskOrderFinancials(order, {
      canViewFinancials: this.canViewFinancials(command),
      canViewPayments: this.permissions.canUser(command.currentUser, 'payments.view'),
    });
  }

  async getAudit(command: GetOrderAuditCommand): Promise<OrderAuditListResponseDto> {
    this.requireViewPermission(command);
    this.requireAuditViewPermission(command);
    this.requireFinanceVisibility(command);

    const order = await this.ports.reader.getOrderById(command);

    if (!order) {
      throw new OrderNotFoundError(command.orderId);
    }

    return this.ports.reader.getOrderAudit(command);
  }

  async getFormData(command: GetOrderFormDataCommand): Promise<OrderFormDataResponseDto> {
    this.requireViewPermission(command);
    const response = await this.ports.reader.getOrderFormData(command);

    if (this.canViewFinancials(command)) {
      return response;
    }

    return {
      ...response,
      millingTypes: response.millingTypes.map((millingType) => ({
        ...millingType,
        costPerSqm: null,
      })),
      paymentStatuses: [],
      paymentTypes: [],
    };
  }

  private requireViewPermission(command: Pick<ListOrdersCommand, 'currentUser'>): void {
    if (!this.permissions.canUser(command.currentUser, 'orders.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.view'],
      });
    }
  }

  private requireAuditViewPermission(command: Pick<ListOrdersCommand, 'currentUser'>): void {
    if (!this.permissions.canUser(command.currentUser, 'orders.view_audit')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.view_audit'],
      });
    }
  }

  private requireFinanceVisibility(command: Pick<ListOrdersCommand, 'currentUser'>): void {
    if (!this.permissions.canUser(command.currentUser, 'orders.view_financials')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.view_financials'],
      });
    }
  }

  private canViewFinancials(command: Pick<ListOrdersCommand, 'currentUser'>): boolean {
    return this.permissions.canUser(command.currentUser, 'orders.view_financials');
  }

  private rejectFinancialListControls(command: ListOrdersCommand): void {
    if (
      FINANCIAL_ORDER_SORT_FIELDS.has(command.query.sortBy) ||
      command.query.paymentStatusId !== undefined
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.view_financials'],
      });
    }
  }
}

function maskOrderListItemFinancials(item: OrderListResponseDto['data'][number]): OrderListResponseDto['data'][number] {
  return {
    ...item,
    paymentDate: null,
    paymentStatusId: 0,
    paymentStatusName: '',
    totalAmount: 0,
    discount: 0,
    surcharge: 0,
    finalAmount: 0,
    paidAmount: 0,
    debtAmount: 0,
  };
}

function maskOrderFinancials(
  order: OrderDto,
  access: { canViewFinancials: boolean; canViewPayments: boolean },
): OrderDto {
  if (access.canViewFinancials && access.canViewPayments) {
    return order;
  }

  if (access.canViewFinancials) {
    return { ...order, payments: [] };
  }

  return {
    ...order,
    header: {
      ...order.header,
      paymentDate: null,
      paymentStatusId: 0,
      totalAmount: 0,
      discount: 0,
      surcharge: 0,
      finalAmount: 0,
      paidAmount: 0,
    },
    details: order.details.map((detail) => ({
      ...detail,
      millingCostPerSqm: null,
      detailCost: 0,
    })),
    payments: [],
    requirements: order.requirements.map((requirement) => ({
      ...requirement,
      purchasePrice: null,
    })),
    totals: {
      ...order.totals,
      totalAmount: 0,
      finalAmount: 0,
      paidAmount: 0,
      debtAmount: 0,
    },
  };
}
