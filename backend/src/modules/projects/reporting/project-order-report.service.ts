import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { ProjectOrderReportQuery, ProjectOrderReportResponseDto } from './project-order-report.dto';
import type { ProjectOrderReportRepositoryPort } from './project-order-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['projects.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListProjectOrderReportCommand {
  currentUser: CurrentUser;
  query: ProjectOrderReportQuery;
  requestId?: string;
}

export interface ProjectOrderReportServicePorts {
  reports: ProjectOrderReportRepositoryPort;
  permissions?: PermissionsService;
}

export class ProjectOrderReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectOrderReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listOrderIds(command: ListProjectOrderReportCommand): Promise<ProjectOrderReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listOrderIds(command.query);
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
