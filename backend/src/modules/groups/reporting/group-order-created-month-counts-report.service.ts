import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GroupOrderCreatedMonthCountsReportQuery,
  GroupOrderCreatedMonthCountsReportResponseDto,
} from './group-order-created-month-counts-report.dto';
import type { GroupOrderCreatedMonthCountsReportRepositoryPort } from './group-order-created-month-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['groups.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListGroupOrderCreatedMonthCountsReportCommand {
  currentUser: CurrentUser;
  query: GroupOrderCreatedMonthCountsReportQuery;
  requestId?: string;
}

export interface GroupOrderCreatedMonthCountsReportPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName, requestId?: string): boolean;
}

export interface GroupOrderCreatedMonthCountsReportServicePorts {
  reports: GroupOrderCreatedMonthCountsReportRepositoryPort;
  permissions?: GroupOrderCreatedMonthCountsReportPermissionsPort;
}

export class GroupOrderCreatedMonthCountsReportService {
  private readonly permissions: GroupOrderCreatedMonthCountsReportPermissionsPort;

  constructor(private readonly ports: GroupOrderCreatedMonthCountsReportServicePorts) {
    const defaultPermissions = new PermissionsService();
    this.permissions = ports.permissions ?? {
      canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean {
        return defaultPermissions.canUser(user, permission);
      },
    };
  }

  async listOrderCreatedMonthCounts(
    command: ListGroupOrderCreatedMonthCountsReportCommand,
  ): Promise<GroupOrderCreatedMonthCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS, command.requestId);

    return this.ports.reports.listOrderCreatedMonthCounts(command.query);
  }

  private requirePermissions(
    currentUser: CurrentUser,
    requiredPermissions: readonly PermissionName[],
    requestId?: string,
  ): void {
    const missingPermissions = requiredPermissions.filter(
      (permission) => !this.permissions.canUser(currentUser, permission, requestId),
    );

    if (missingPermissions.length > 0) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [...requiredPermissions],
        missingPermissions,
      });
    }
  }
}
