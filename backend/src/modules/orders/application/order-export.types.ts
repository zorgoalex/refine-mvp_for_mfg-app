import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ExportOrderResponseDto,
  NormalizedExportOrderRequestDto,
} from '../dto/export-order.dto';

export interface ExportOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  request: NormalizedExportOrderRequestDto;
  requestId?: string;
}

export interface OrderExportPort {
  exportToGoogleDrive(command: ExportOrderCommand): Promise<ExportOrderResponseDto>;
}

export interface OrderExportRateLimiterPort {
  assertAllowed(command: ExportOrderCommand): void;
}
