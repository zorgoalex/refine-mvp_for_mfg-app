import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  DeadlineDefaultScheduleDto,
  ReplaceDeadlineDefaultScheduleRequestDto,
} from '../dto/deadline-default-schedule.dto';

export interface DeadlineDefaultScheduleRepositoryPort {
  getSchedule(): Promise<DeadlineDefaultScheduleDto>;
  replaceSchedule(input: {
    dto: ReplaceDeadlineDefaultScheduleRequestDto;
    currentUser: CurrentUser;
    requestId?: string;
  }): Promise<DeadlineDefaultScheduleDto>;
}

export class DeadlineDefaultScheduleService {
  private readonly permissions: PermissionsService;

  constructor(
    private readonly repository: DeadlineDefaultScheduleRepositoryPort,
    permissions?: PermissionsService,
  ) {
    this.permissions = permissions ?? new PermissionsService();
  }

  async get(command: { currentUser: CurrentUser }): Promise<DeadlineDefaultScheduleDto> {
    if (
      !this.permissions.canUserAny(command.currentUser, [
        'deadlines.view',
        'settings.manage',
      ])
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра сроков', {
        requiredPermissions: ['deadlines.view', 'settings.manage'],
      });
    }

    return this.repository.getSchedule();
  }

  async replace(command: {
    currentUser: CurrentUser;
    requestId?: string;
    dto: ReplaceDeadlineDefaultScheduleRequestDto;
  }): Promise<DeadlineDefaultScheduleDto> {
    if (!this.permissions.canUser(command.currentUser, 'settings.manage')) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для настройки сроков', {
        requiredPermissions: ['settings.manage'],
      });
    }

    return this.repository.replaceSchedule(command);
  }
}

export class UnavailableDeadlineDefaultScheduleRepository
  implements DeadlineDefaultScheduleRepositoryPort
{
  async getSchedule(): Promise<DeadlineDefaultScheduleDto> {
    throw unavailable();
  }

  async replaceSchedule(): Promise<DeadlineDefaultScheduleDto> {
    throw unavailable();
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
