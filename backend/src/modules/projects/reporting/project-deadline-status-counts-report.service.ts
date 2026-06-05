import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ProjectDeadlineStatusCountsReportQuery,
  ProjectDeadlineStatusCountsReportResponseDto,
} from './project-deadline-status-counts-report.dto';
import type { ProjectDeadlineStatusCountsReportRepositoryPort } from './project-deadline-status-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = [
  'projects.view',
  'orders.view',
  'deadlines.view',
] as const satisfies readonly PermissionName[];

export interface ListProjectDeadlineStatusCountsReportCommand {
  currentUser: CurrentUser;
  query: ProjectDeadlineStatusCountsReportQuery;
  requestId?: string;
}

export interface ProjectDeadlineStatusCountsReportServicePorts {
  reports: ProjectDeadlineStatusCountsReportRepositoryPort;
  permissions?: PermissionsService;
}

export class ProjectDeadlineStatusCountsReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectDeadlineStatusCountsReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listDeadlineStatusCounts(
    command: ListProjectDeadlineStatusCountsReportCommand,
  ): Promise<ProjectDeadlineStatusCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listDeadlineStatusCounts(command.query);
  }

  private requirePermissions(currentUser: CurrentUser, requiredPermissions: readonly PermissionName[]): void {
    const missingPermissions = requiredPermissions.filter((permission) => !this.permissions.canUser(currentUser, permission));

    if (missingPermissions.length > 0) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: [...requiredPermissions],
        missingPermissions,
      });
    }
  }
}
