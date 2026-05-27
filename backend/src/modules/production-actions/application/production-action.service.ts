import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { PermissionName } from '../../../permissions/permissions';
import type {
  ActivateProductionStageCommand,
  ActivateDetailProductionStageCommand,
  ChangeOrderStatusCommand,
  ChangeOrderStatusFromDeadlineCommand,
  ChangeProductionStatusFromDeadlineCommand,
  ChangePaymentStatusCommand,
  ChangeProductionStatusCommand,
  DeactivateProductionStageCommand,
  MoveCalendarDateCommand,
  ProductionActionRepositoryPort,
} from './production-action.types';

export interface ProductionActionServicePorts {
  productionActions: ProductionActionRepositoryPort;
  permissions?: PermissionsService;
}

export class ProductionActionService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProductionActionServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async moveCalendarDate(command: MoveCalendarDateCommand) {
    this.requirePermissions(command.currentUser, ['calendar.view', 'orders.update']);
    return this.ports.productionActions.moveCalendarDate(command);
  }

  async changeOrderStatus(command: ChangeOrderStatusCommand) {
    this.requirePermissions(command.currentUser, ['orders.change_status', 'orders.update']);
    return this.ports.productionActions.changeOrderStatus(command);
  }

  async changeOrderStatusFromDeadline(command: ChangeOrderStatusFromDeadlineCommand) {
    return this.ports.productionActions.changeOrderStatusFromDeadline(command);
  }

  async changeProductionStatusFromDeadline(command: ChangeProductionStatusFromDeadlineCommand) {
    return this.ports.productionActions.changeProductionStatusFromDeadline(command);
  }

  async changePaymentStatus(command: ChangePaymentStatusCommand) {
    this.requirePermissions(command.currentUser, ['payments.update', 'orders.update']);
    return this.ports.productionActions.changePaymentStatus(command);
  }

  async changeProductionStatus(command: ChangeProductionStatusCommand) {
    this.requirePermissions(command.currentUser, [
      'orders.change_production_status',
      'orders.update',
    ]);
    return this.ports.productionActions.changeProductionStatus(command);
  }

  async activateProductionStage(command: ActivateProductionStageCommand) {
    this.requirePermissions(command.currentUser, [
      'orders.change_production_status',
      'orders.update',
    ]);
    return this.ports.productionActions.activateProductionStage(command);
  }

  async deactivateProductionStage(command: DeactivateProductionStageCommand) {
    this.requirePermissions(command.currentUser, [
      'orders.change_production_status',
      'orders.update',
    ]);
    return this.ports.productionActions.deactivateProductionStage(command);
  }

  async activateDetailProductionStage(command: ActivateDetailProductionStageCommand) {
    this.requirePermissions(command.currentUser, [
      'orders.change_production_status',
      'orders.update',
    ]);
    return this.ports.productionActions.activateDetailProductionStage(command);
  }

  private requirePermissions(
    currentUser: MoveCalendarDateCommand['currentUser'],
    requiredPermissions: readonly PermissionName[],
  ): void {
    const missingPermissions = requiredPermissions.filter(
      (permission) => !this.permissions.canUser(currentUser, permission),
    );

    if (missingPermissions.length > 0) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions,
        missingPermissions,
      });
    }
  }
}
