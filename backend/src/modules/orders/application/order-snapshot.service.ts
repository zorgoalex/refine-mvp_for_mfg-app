import { ApiError } from '../../../common/errors/api-error';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ExportedOrderSnapshotBatchFile,
  ExportedOrderSnapshotFile,
  ExportOrderSnapshotBatchCommand,
  ExportOrderSnapshotCommand,
  ImportOrderSnapshotBatchCommand,
  ImportOrderSnapshotCommand,
  OrderSnapshotPort,
} from './order-snapshot.types';
import type {
  ImportOrderSnapshotBatchResponseDto,
  ImportOrderSnapshotResponseDto,
} from '../dto/order-snapshot.dto';
import type { OrderPermissionCheckerPort } from './order-transaction.types';

export interface OrderSnapshotServicePorts {
  snapshots: OrderSnapshotPort;
  permissions?: OrderPermissionCheckerPort;
}

export class OrderSnapshotService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: OrderSnapshotServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  exportOrderSnapshot(command: ExportOrderSnapshotCommand): Promise<ExportedOrderSnapshotFile> {
    this.require(command, 'orders.export');
    return this.ports.snapshots.exportOrderSnapshot(command);
  }

  exportOrderSnapshotBatch(
    command: ExportOrderSnapshotBatchCommand,
  ): Promise<ExportedOrderSnapshotBatchFile> {
    this.require(command, 'orders.export');
    return this.ports.snapshots.exportOrderSnapshotBatch(command);
  }

  importOrderSnapshot(command: ImportOrderSnapshotCommand): Promise<ImportOrderSnapshotResponseDto> {
    this.require(command, 'orders.import');
    return this.ports.snapshots.importOrderSnapshot(command);
  }

  importOrderSnapshotBatch(
    command: ImportOrderSnapshotBatchCommand,
  ): Promise<ImportOrderSnapshotBatchResponseDto> {
    this.require(command, 'orders.import');
    return this.ports.snapshots.importOrderSnapshotBatch(command);
  }

  private require(
    command: Pick<ExportOrderSnapshotCommand | ImportOrderSnapshotCommand, 'currentUser'>,
    permission: 'orders.export' | 'orders.import',
  ): void {
    if (!this.permissions.canUser(command.currentUser, permission)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [permission],
      });
    }
  }
}
