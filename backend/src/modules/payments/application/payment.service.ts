import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { PermissionName } from '../../../permissions/permissions';
import type {
  CreatePaymentCommand,
  DeletePaymentCommand,
  PaymentRepositoryPort,
  UpdatePaymentCommand,
} from './payment-command.types';

export interface PaymentServicePorts {
  payments: PaymentRepositoryPort;
  permissions?: PermissionsService;
}

export class PaymentService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: PaymentServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async create(command: CreatePaymentCommand) {
    this.requirePermission(command, 'payments.create');
    return this.ports.payments.createPayment(command);
  }

  async update(command: UpdatePaymentCommand) {
    this.requirePermission(command, 'payments.update');
    return this.ports.payments.updatePayment(command);
  }

  async delete(command: DeletePaymentCommand) {
    this.requirePermission(command, 'payments.delete');
    return this.ports.payments.deletePayment(command);
  }

  private requirePermission(
    command: Pick<CreatePaymentCommand | UpdatePaymentCommand | DeletePaymentCommand, 'currentUser'>,
    permission: PermissionName,
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}

