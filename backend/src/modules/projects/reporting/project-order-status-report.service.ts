import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ProjectOrderStatusReportQuery,
  ProjectOrderStatusReportResponseDto,
} from './project-order-status-report.dto';
import type { ProjectOrderStatusReportRepositoryPort } from './project-order-status-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['projects.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListProjectOrderStatusReportCommand {
  currentUser: CurrentUser;
  query: ProjectOrderStatusReportQuery;
  requestId?: string;
}

export interface ProjectOrderStatusReportServicePorts {
  reports: ProjectOrderStatusReportRepositoryPort;
  permissions?: PermissionsService;
}

export class ProjectOrderStatusReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: ProjectOrderStatusReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listOrderStatusCounts(
    command: ListProjectOrderStatusReportCommand,
  ): Promise<ProjectOrderStatusReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listOrderStatusCounts(command.query);
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
