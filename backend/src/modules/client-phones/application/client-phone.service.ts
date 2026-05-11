import { ApiError } from '../../../common/errors/api-error';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ClientPhoneRepositoryPort,
  CreateClientPhoneCommand,
  DeleteClientPhoneCommand,
  UpdateClientPhoneCommand,
} from './client-phone.types';

export interface ClientPhoneServicePorts {
  clientPhones: ClientPhoneRepositoryPort;
  permissions?: PermissionsService;
}

export class ClientPhoneService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ClientPhoneServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async create(command: CreateClientPhoneCommand) {
    this.requirePermission(command, 'clients.update');
    return this.ports.clientPhones.createClientPhone(command);
  }

  async update(command: UpdateClientPhoneCommand) {
    this.requirePermission(command, 'clients.update');
    return this.ports.clientPhones.updateClientPhone(command);
  }

  async delete(command: DeleteClientPhoneCommand) {
    this.requirePermission(command, 'clients.update');
    return this.ports.clientPhones.deleteClientPhone(command);
  }

  private requirePermission(
    command: Pick<CreateClientPhoneCommand | UpdateClientPhoneCommand | DeleteClientPhoneCommand, 'currentUser'>,
    permission: PermissionName,
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
