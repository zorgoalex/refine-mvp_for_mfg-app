import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  ProjectOrderCreatedMonthCountsReportQuery,
  ProjectOrderCreatedMonthCountsReportResponseDto,
} from './project-order-created-month-counts-report.dto';
import type { ProjectOrderCreatedMonthCountsReportRepositoryPort } from './project-order-created-month-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['projects.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListProjectOrderCreatedMonthCountsReportCommand {
  currentUser: CurrentUser;
  query: ProjectOrderCreatedMonthCountsReportQuery;
  requestId?: string;
}

export interface ProjectOrderCreatedMonthCountsReportPermissionsPort {
  canUser(user: CurrentUser | null | undefined, permission: PermissionName, requestId?: string): boolean;
}

export interface ProjectOrderCreatedMonthCountsReportServicePorts {
  reports: ProjectOrderCreatedMonthCountsReportRepositoryPort;
  permissions?: ProjectOrderCreatedMonthCountsReportPermissionsPort;
}

export class ProjectOrderCreatedMonthCountsReportService {
  private readonly permissions: ProjectOrderCreatedMonthCountsReportPermissionsPort;

  constructor(private readonly ports: ProjectOrderCreatedMonthCountsReportServicePorts) {
    const defaultPermissions = new PermissionsService();
    this.permissions = ports.permissions ?? {
      canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean {
        return defaultPermissions.canUser(user, permission);
      },
    };
  }

  async listOrderCreatedMonthCounts(
    command: ListProjectOrderCreatedMonthCountsReportCommand,
  ): Promise<ProjectOrderCreatedMonthCountsReportResponseDto> {
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
