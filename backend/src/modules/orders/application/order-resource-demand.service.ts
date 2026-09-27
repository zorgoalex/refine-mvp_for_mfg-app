import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import {
  RESOURCE_PROCUREMENT_BULK_LIMIT,
  type BulkOrderResourceProcurementCommand,
  type BulkOrderResourceProcurementResultDto,
  type GetOrderResourceCardCommand,
  type ListOrderResourceDemandsCommand,
  type OrderResourceByMaterialResponseDto,
  type OrderResourceCardResponseDto,
  type OrderResourceDemandRepositoryPort,
  type OrderResourceDemandResponseDto,
  type OrderResourceProcurementResultDto,
  type OrderResourceReadOptions,
  type SetOrderResourceProcurementCommand,
} from './order-resource-demand.types';

export interface OrderResourceProcurementPort {
  set(command: SetOrderResourceProcurementCommand): Promise<OrderResourceProcurementResultDto>;
  bulk(command: BulkOrderResourceProcurementCommand): Promise<BulkOrderResourceProcurementResultDto>;
}

export interface OrderResourceDemandServicePorts {
  demands: OrderResourceDemandRepositoryPort;
  procurement?: OrderResourceProcurementPort;
  permissions?: OrderPermissionCheckerPort;
  /** Пул БД для denied-аудита вне транзакции команды. */
  auditClient?: DatabaseClient;
}

const VIEW_PERMISSION = 'orders.view';
const MANAGE_PROCUREMENT_PERMISSION = 'procurement.manage';

export class OrderResourceDemandService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: OrderResourceDemandServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions = { procurementEnabled: false },
  ): Promise<OrderResourceDemandResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.demands.list(command, options);
  }

  async getCard(
    command: GetOrderResourceCardCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceCardResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.demands.getCard(command, options);
  }

  async listByMaterial(
    command: ListOrderResourceDemandsCommand,
    options: OrderResourceReadOptions,
  ): Promise<OrderResourceByMaterialResponseDto> {
    this.requireView(command.currentUser);
    return this.ports.demands.listByMaterial(command, options);
  }

  async setProcurement(command: SetOrderResourceProcurementCommand): Promise<OrderResourceProcurementResultDto> {
    await this.requireManage(command.currentUser, command.requestId, String(command.orderId), command.orderId);
    return this.procurementPort().set(command);
  }

  async bulkProcurement(command: BulkOrderResourceProcurementCommand): Promise<BulkOrderResourceProcurementResultDto> {
    await this.requireManage(command.currentUser, command.requestId, 'bulk', null);
    if (command.items.length === 0 || command.items.length > RESOURCE_PROCUREMENT_BULK_LIMIT) {
      throw new ApiError(422, 'PROCUREMENT_BULK_SIZE_INVALID', `Групповая отметка: от 1 до ${RESOURCE_PROCUREMENT_BULK_LIMIT} заказов`, {
        limit: RESOURCE_PROCUREMENT_BULK_LIMIT,
      });
    }
    if (new Set(command.items.map((item) => item.orderId)).size !== command.items.length) {
      throw new ApiError(422, 'PROCUREMENT_BULK_DUPLICATE_ORDER', 'Заказ указан в групповой отметке дважды');
    }
    return this.procurementPort().bulk(command);
  }

  private procurementPort(): OrderResourceProcurementPort {
    if (!this.ports.procurement) throw new Error('Order resource procurement port is not configured');
    return this.ports.procurement;
  }

  private requireView(user: CurrentUser): void {
    if (!this.permissions.canUser(user, VIEW_PERMISSION)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра потребностей заказов', {
        requiredPermissions: [VIEW_PERMISSION],
      });
    }
  }

  private async requireManage(
    user: CurrentUser,
    requestId: string,
    entityId: string,
    orderId: number | null,
  ): Promise<void> {
    if (this.permissions.canUser(user, MANAGE_PROCUREMENT_PERMISSION)) return;
    if (this.ports.auditClient) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'order_resource.procurement_denied',
        entityType: orderId === null ? 'order_resource_procurement_bulk' : 'order',
        entityId,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-order-resource-procurement',
        relatedOrderId: orderId,
        reason: 'missing_permission',
        requiredPermissions: [MANAGE_PROCUREMENT_PERMISSION],
        relatedEntities: orderId === null ? [] : [{ entityType: 'order', entityId: orderId }],
      });
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для отметки закупа', {
      requiredPermissions: [MANAGE_PROCUREMENT_PERMISSION],
    });
  }
}
