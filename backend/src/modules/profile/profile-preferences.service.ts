import { ApiError } from '../../common/errors/api-error';
import type {
  GetUserPreferencesCommand,
  PromoteReferenceUsageCommand,
  UpdateUserPreferencesCommand,
  UserPreferencesDto,
  UserPreferencesRepositoryPort,
} from './profile-preferences.types';

export class ProfilePreferencesService {
  constructor(private readonly repository: UserPreferencesRepositoryPort) {}

  get(command: GetUserPreferencesCommand): Promise<UserPreferencesDto> {
    return this.repository.getUserPreferences(parseCurrentUserId(command.currentUser.id));
  }

  update(command: UpdateUserPreferencesCommand): Promise<UserPreferencesDto> {
    return this.repository.updateUserPreferences(
      parseCurrentUserId(command.currentUser.id),
      command.preferences,
    );
  }

  promoteReferenceUsage(command: PromoteReferenceUsageCommand): Promise<UserPreferencesDto> {
    return this.repository.promoteReferenceUsage(
      parseCurrentUserId(command.currentUser.id),
      command.resource,
      command.entityId,
    );
  }
}

function parseCurrentUserId(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError(422, 'INVALID_CURRENT_USER', 'Invalid current user id');
  }
  return parsed;
}
