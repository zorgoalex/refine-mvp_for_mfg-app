import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GroupOrderStatusReportQuery,
  GroupOrderStatusReportResponseDto,
} from './group-order-status-report.dto';
import type { GroupOrderStatusReportRepositoryPort } from './group-order-status-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['groups.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListGroupOrderStatusReportCommand {
  currentUser: CurrentUser;
  query: GroupOrderStatusReportQuery;
  requestId?: string;
}

export interface GroupOrderStatusReportServicePorts {
  reports: GroupOrderStatusReportRepositoryPort;
  permissions?: PermissionsService;
}

export class GroupOrderStatusReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: GroupOrderStatusReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listOrderStatusCounts(
    command: ListGroupOrderStatusReportCommand,
  ): Promise<GroupOrderStatusReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listOrderStatusCounts(command.query);
  }

  private requirePermissions(currentUser: CurrentUser, requiredPermissions: readonly PermissionName[]): void {
    const missingPermissions = requiredPermissions.filter(
      (permission) => !this.permissions.canUser(currentUser, permission),
    );

    if (missingPermissions.length > 0) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [...requiredPermissions],
        missingPermissions,
      });
    }
  }
}
