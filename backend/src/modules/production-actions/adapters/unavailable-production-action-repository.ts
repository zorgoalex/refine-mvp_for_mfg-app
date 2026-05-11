import { ApiError } from '../../../common/errors/api-error';
import type {
  ActivateProductionStageCommand,
  ChangeOrderStatusCommand,
  DeactivateProductionStageCommand,
  MoveCalendarDateCommand,
  ProductionActionRepositoryPort,
} from '../application/production-action.types';

export class UnavailableProductionActionRepository implements ProductionActionRepositoryPort {
  moveCalendarDate(_command: MoveCalendarDateCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changeOrderStatus(_command: ChangeOrderStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }

  activateProductionStage(_command: ActivateProductionStageCommand) {
    return Promise.reject(databaseUnavailable());
  }

  deactivateProductionStage(_command: DeactivateProductionStageCommand) {
    return Promise.reject(databaseUnavailable());
  }
}

function databaseUnavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
