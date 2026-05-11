import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ImportOrderSnapshotBatchResponseDto,
  ImportOrderSnapshotResponseDto,
  OrderSnapshotDto,
} from '../dto/order-snapshot.dto';

export interface ExportOrderSnapshotCommand {
  currentUser: CurrentUser;
  orderId: number;
  requestId?: string;
}

export interface ExportOrderSnapshotBatchCommand {
  currentUser: CurrentUser;
  dateFrom: string;
  dateTo: string;
  requestId?: string;
}

export interface ImportOrderSnapshotCommand {
  currentUser: CurrentUser;
  snapshot: OrderSnapshotDto;
  requestId?: string;
}

export interface ImportOrderSnapshotBatchCommand {
  currentUser: CurrentUser;
  zipBase64: string;
  requestId?: string;
}

export interface ExportedOrderSnapshotFile {
  fileName: string;
  content: string;
}

export interface ExportedOrderSnapshotBatchFile {
  fileName: string;
  content: Buffer;
  orderCount: number;
}

export interface OrderSnapshotPort {
  exportOrderSnapshot(command: ExportOrderSnapshotCommand): Promise<ExportedOrderSnapshotFile>;
  exportOrderSnapshotBatch(
    command: ExportOrderSnapshotBatchCommand,
  ): Promise<ExportedOrderSnapshotBatchFile>;
  importOrderSnapshot(command: ImportOrderSnapshotCommand): Promise<ImportOrderSnapshotResponseDto>;
  importOrderSnapshotBatch(
    command: ImportOrderSnapshotBatchCommand,
  ): Promise<ImportOrderSnapshotBatchResponseDto>;
}
