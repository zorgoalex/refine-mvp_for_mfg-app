import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ExportOrderResponseDto,
  NormalizedExportOrderRequestDto,
} from '../dto/export-order.dto';

export interface ExportOrderCommand {
  currentUser: CurrentUser;
  orderId: number;
  request: NormalizedExportOrderRequestDto;
}

export interface OrderExportPort {
  exportToGoogleDrive(command: ExportOrderCommand): Promise<ExportOrderResponseDto>;
}
