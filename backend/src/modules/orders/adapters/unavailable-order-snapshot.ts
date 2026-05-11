import { ApiError } from '../../../common/errors/api-error';
import type {
  ExportedOrderSnapshotBatchFile,
  ExportedOrderSnapshotFile,
  ExportOrderSnapshotBatchCommand,
  ExportOrderSnapshotCommand,
  ImportOrderSnapshotBatchCommand,
  ImportOrderSnapshotCommand,
  OrderSnapshotPort,
} from '../application/order-snapshot.types';
import type {
  ImportOrderSnapshotBatchResponseDto,
  ImportOrderSnapshotResponseDto,
} from '../dto/order-snapshot.dto';

export class UnavailableOrderSnapshot implements OrderSnapshotPort {
  exportOrderSnapshot(_command: ExportOrderSnapshotCommand): Promise<ExportedOrderSnapshotFile> {
    throw unavailable();
  }

  exportOrderSnapshotBatch(
    _command: ExportOrderSnapshotBatchCommand,
  ): Promise<ExportedOrderSnapshotBatchFile> {
    throw unavailable();
  }

  importOrderSnapshot(
    _command: ImportOrderSnapshotCommand,
  ): Promise<ImportOrderSnapshotResponseDto> {
    throw unavailable();
  }

  importOrderSnapshotBatch(
    _command: ImportOrderSnapshotBatchCommand,
  ): Promise<ImportOrderSnapshotBatchResponseDto> {
    throw unavailable();
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
