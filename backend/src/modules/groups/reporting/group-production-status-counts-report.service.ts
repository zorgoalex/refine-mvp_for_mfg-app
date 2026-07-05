import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GroupProductionStatusCountsReportQuery,
  GroupProductionStatusCountsReportResponseDto,
} from './group-production-status-counts-report.dto';
import type { GroupProductionStatusCountsReportRepositoryPort } from './group-production-status-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['groups.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListGroupProductionStatusCountsReportCommand {
  currentUser: CurrentUser;
  query: GroupProductionStatusCountsReportQuery;
  requestId?: string;
}

export interface GroupProductionStatusCountsReportServicePorts {
  reports: GroupProductionStatusCountsReportRepositoryPort;
  permissions?: PermissionsService;
}

export class GroupProductionStatusCountsReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: GroupProductionStatusCountsReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listProductionStatusCounts(
    command: ListGroupProductionStatusCountsReportCommand,
  ): Promise<GroupProductionStatusCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listProductionStatusCounts(command.query);
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
