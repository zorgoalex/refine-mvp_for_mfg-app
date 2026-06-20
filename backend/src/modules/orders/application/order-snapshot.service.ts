import JSZip from 'jszip';
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
    // Sync permission throws first (kept synchronous so callers see them immediately).
    this.require(command, 'orders.import');
    this.requireFinanceImportPermissions(command);
    // The adapter batch dispatches to its own internal importOrderSnapshot, which does NOT
    // re-run the service permission gate, so the sheet_materials.view check MUST be enforced
    // here before dispatch — otherwise a batch ZIP could import sheet-bearing orders without
    // the permission a single-file import requires. (Async because it parses the ZIP.)
    return this.requireSheetMaterialPermissionForBatch(command).then(() =>
      this.ports.snapshots.importOrderSnapshotBatch(command),
    );
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

  /**
   * Batch sheet gate: pre-scan the ZIP members so a batch import enforces `sheet_materials.view`
   * exactly like the single-file path (the adapter batch loops to its own internal import and
   * never re-applies this service-layer gate). If ANY member's order header or detail carries a
   * sheet_material_type_id, require the permission before any DB write. Malformed members are
   * skipped here and surface as per-file errors during the adapter import.
   */
  private async requireSheetMaterialPermissionForBatch(
    command: ImportOrderSnapshotBatchCommand,
  ): Promise<void> {
    const zip = await JSZip.loadAsync(Buffer.from(command.zipBase64, 'base64'));
    const files = Object.values(zip.files).filter(
      (file) => !file.dir && file.name.toLowerCase().endsWith('.json'),
    );
    for (const file of files) {
      let parsed: { data?: { order?: { sheetMaterialTypeId?: number | null }; details?: Array<{ sheetMaterialTypeId?: number | null }> } };
      try {
        parsed = JSON.parse(await file.async('string'));
      } catch {
        continue; // malformed member → adapter reports it per-file; not a gate bypass
      }
      const items: Array<{ sheetMaterialTypeId?: number | null }> = [
        ...(parsed.data?.order ? [parsed.data.order] : []),
        ...(parsed.data?.details ?? []),
      ];
      if (items.some((item) => item.sheetMaterialTypeId != null)) {
        if (!this.permissions.canUser(command.currentUser, 'sheet_materials.view')) {
          throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
            requiredPermissions: ['sheet_materials.view'],
          });
        }
        return; // one sheet-bearing member is enough to require the permission
      }
    }
  }
}
