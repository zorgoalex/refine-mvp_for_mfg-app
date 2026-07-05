import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { GroupOrderReportQuery, GroupOrderReportResponseDto } from './group-order-report.dto';
import type { GroupOrderReportRepositoryPort } from './group-order-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['groups.view', 'orders.view'] as const;

export interface ListGroupOrderReportCommand {
  currentUser: CurrentUser;
  query: GroupOrderReportQuery;
  requestId?: string;
}

export interface GroupOrderReportServicePorts {
  reports: GroupOrderReportRepositoryPort;
  permissions?: PermissionsService;
}

export class GroupOrderReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: GroupOrderReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listOrderIds(command: ListGroupOrderReportCommand): Promise<GroupOrderReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listOrderIds(command.query);
  }

  private requirePermissions(currentUser: CurrentUser, requiredPermissions: readonly string[]): void {
    const missingPermissions = requiredPermissions.filter(
      (permission) => !this.permissions.canUser(currentUser, permission as PermissionName),
    );

    if (missingPermissions.length > 0) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [...requiredPermissions],
        missingPermissions,
      });
    }
  }
}
