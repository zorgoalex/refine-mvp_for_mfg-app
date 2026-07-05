import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GroupDeadlineStatusCountsReportQuery,
  GroupDeadlineStatusCountsReportResponseDto,
} from './group-deadline-status-counts-report.dto';
import type { GroupDeadlineStatusCountsReportRepositoryPort } from './group-deadline-status-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = [
  'groups.view',
  'orders.view',
  'deadlines.view',
] as const satisfies readonly PermissionName[];

export interface ListGroupDeadlineStatusCountsReportCommand {
  currentUser: CurrentUser;
  query: GroupDeadlineStatusCountsReportQuery;
  requestId?: string;
}

export interface GroupDeadlineStatusCountsReportServicePorts {
  reports: GroupDeadlineStatusCountsReportRepositoryPort;
  permissions?: PermissionsService;
}

export class GroupDeadlineStatusCountsReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: GroupDeadlineStatusCountsReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listDeadlineStatusCounts(
    command: ListGroupDeadlineStatusCountsReportCommand,
  ): Promise<GroupDeadlineStatusCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listDeadlineStatusCounts(command.query);
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
