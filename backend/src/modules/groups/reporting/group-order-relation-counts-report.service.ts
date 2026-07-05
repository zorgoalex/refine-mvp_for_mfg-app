import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  GroupOrderRelationCountsReportQuery,
  GroupOrderRelationCountsReportResponseDto,
} from './group-order-relation-counts-report.dto';
import type { GroupOrderRelationCountsReportRepositoryPort } from './group-order-relation-counts-report.repository';

const REQUIRED_REPORT_PERMISSIONS = ['groups.view', 'orders.view'] as const satisfies readonly PermissionName[];

export interface ListGroupOrderRelationCountsReportCommand {
  currentUser: CurrentUser;
  query: GroupOrderRelationCountsReportQuery;
  requestId?: string;
}

export interface GroupOrderRelationCountsReportServicePorts {
  reports: GroupOrderRelationCountsReportRepositoryPort;
  permissions?: PermissionsService;
}

export class GroupOrderRelationCountsReportService {
  private readonly permissions: PermissionsService;

  constructor(private readonly ports: GroupOrderRelationCountsReportServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listOrderRelationCounts(
    command: ListGroupOrderRelationCountsReportCommand,
  ): Promise<GroupOrderRelationCountsReportResponseDto> {
    this.requirePermissions(command.currentUser, REQUIRED_REPORT_PERMISSIONS);

    return this.ports.reports.listOrderRelationCounts(command.query);
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
