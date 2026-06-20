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
  OrderSnapshotDetailDto,
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
    this.requireFinanceVisibility(command);
    return this.ports.snapshots.exportOrderSnapshot(command);
  }

  exportOrderSnapshotBatch(
    command: ExportOrderSnapshotBatchCommand,
  ): Promise<ExportedOrderSnapshotBatchFile> {
    this.require(command, 'orders.export');
    this.requireFinanceVisibility(command);
    return this.ports.snapshots.exportOrderSnapshotBatch(command);
  }

  importOrderSnapshot(command: ImportOrderSnapshotCommand): Promise<ImportOrderSnapshotResponseDto> {
    this.require(command, 'orders.import');
    this.requireFinanceImportPermissions(command);
    this.requireSheetMaterialPermissionIfNeeded(command.currentUser, [
      command.snapshot.data.order,
      ...command.snapshot.data.details,
    ]);
    return this.ports.snapshots.importOrderSnapshot(command);
  }

  importOrderSnapshotBatch(
    command: ImportOrderSnapshotBatchCommand,
  ): Promise<ImportOrderSnapshotBatchResponseDto> {
    this.require(command, 'orders.import');
    this.requireFinanceImportPermissions(command);
    // Batch: we cannot pre-read stored state here, so we gate on incoming sheet ids.
    // The adapter-tx will enforce sheet guards per-order during the import.
    // If ANY snapshot in the batch contains a sheet id, require sheet_materials.view.
    // (ZIP contents are not yet parsed here; the per-snapshot gate in the adapter catches the rest.)
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

  private requireFinanceVisibility(
    command: Pick<ExportOrderSnapshotCommand, 'currentUser'>,
  ): void {
    if (!this.permissions.canUser(command.currentUser, 'orders.view_financials')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['orders.view_financials'],
      });
    }
  }

  private requireFinanceImportPermissions(
    command: Pick<ImportOrderSnapshotCommand, 'currentUser'>,
  ): void {
    for (const permission of [
      'orders.view_financials',
      'payments.create',
      'payments.update',
      'payments.delete',
    ] as const) {
      if (!this.permissions.canUser(command.currentUser, permission)) {
        throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
          requiredPermissions: [permission],
        });
      }
    }
  }

  /**
   * Gate: if the incoming payload (single snapshot) contains any sheet material type id, the user
   * must hold `sheet_materials.view`. The adapter-tx enforces this for stored-state-only sheet orders
   * (already has a sheet detail but the incoming payload doesn't — caught by assertSheetEligibilityAndNoClear).
   * Placed in the service layer so it is enforced before any DB write, consistent with the
   * order-transaction.service requireSheetMaterials pattern.
   */
  private requireSheetMaterialPermissionIfNeeded(
    currentUser: ImportOrderSnapshotCommand['currentUser'],
    items: Array<{ sheetMaterialTypeId?: number | null }>,
  ): void {
    const touchesSheet = items.some((item) => item.sheetMaterialTypeId != null);
    if (!touchesSheet) return;
    if (!this.permissions.canUser(currentUser, 'sheet_materials.view')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['sheet_materials.view'],
      });
    }
  }
}
