import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ProjectOrderRelationCountsReportQuery,
  ProjectOrderRelationCountsReportResponseDto,
} from './project-order-relation-counts-report.dto';
import type { ProjectOrderRelationCountsReportRepositoryPort } from './project-order-relation-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['projects.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListProjectOrderRelationCountsReportCommand {
  currentUser: CurrentUser;
  query: ProjectOrderRelationCountsReportQuery;
  requestId?: string;
}

export interface ProjectOrderRelationCountsReportServicePorts {
  reports: ProjectOrderRelationCountsReportRepositoryPort;
  permissions?: PermissionsService;
}

export class ProjectOrderRelationCountsReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectOrderRelationCountsReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listOrderRelationCounts(
    command: ListProjectOrderRelationCountsReportCommand,
  ): Promise<ProjectOrderRelationCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listOrderRelationCounts(command.query);
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
