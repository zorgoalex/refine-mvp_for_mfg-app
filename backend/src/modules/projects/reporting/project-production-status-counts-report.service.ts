import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ProjectProductionStatusCountsReportQuery,
  ProjectProductionStatusCountsReportResponseDto,
} from './project-production-status-counts-report.dto';
import type { ProjectProductionStatusCountsReportRepositoryPort } from './project-production-status-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['projects.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListProjectProductionStatusCountsReportCommand {
  currentUser: CurrentUser;
  query: ProjectProductionStatusCountsReportQuery;
  requestId?: string;
}

export interface ProjectProductionStatusCountsReportServicePorts {
  reports: ProjectProductionStatusCountsReportRepositoryPort;
  permissions?: PermissionsService;
}

export class ProjectProductionStatusCountsReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectProductionStatusCountsReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listProductionStatusCounts(
    command: ListProjectProductionStatusCountsReportCommand,
  ): Promise<ProjectProductionStatusCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listProductionStatusCounts(command.query);
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
