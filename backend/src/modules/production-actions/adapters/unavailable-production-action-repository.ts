import { ApiError } from '../../../common/errors/api-error';
import type {
  ActivateProductionStageCommand,
  ActivateDetailProductionStageCommand,
  ChangeBatchDetailProductionStatusCommand,
  ChangeOrderStatusCommand,
  ChangeOrderStatusFromDeadlineCommand,
  ChangePaymentStatusCommand,
  ChangeProductionStatusCommand,
  ChangeProductionStatusFromDeadlineCommand,
  DeactivateProductionStageCommand,
  EnterManualProductionStatusCommand,
  MoveCalendarDateCommand,
  ProductionActionRepositoryPort,
  RestoreAutoProductionStatusCommand,
} from '../application/production-action.types';

export class UnavailableProductionActionRepository implements ProductionActionRepositoryPort {
  moveCalendarDate(_command: MoveCalendarDateCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changeOrderStatus(_command: ChangeOrderStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changeOrderStatusFromDeadline(_command: ChangeOrderStatusFromDeadlineCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changeProductionStatusFromDeadline(_command: ChangeProductionStatusFromDeadlineCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changePaymentStatus(_command: ChangePaymentStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changeProductionStatus(_command: ChangeProductionStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }

  activateProductionStage(_command: ActivateProductionStageCommand) {
    return Promise.reject(databaseUnavailable());
  }

  deactivateProductionStage(_command: DeactivateProductionStageCommand) {
    return Promise.reject(databaseUnavailable());
  }

  activateDetailProductionStage(_command: ActivateDetailProductionStageCommand) {
    return Promise.reject(databaseUnavailable());
  }

  restoreAutoProductionStatus(_command: RestoreAutoProductionStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }

  enterManualProductionStatus(_command: EnterManualProductionStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }

  changeBatchDetailProductionStatus(_command: ChangeBatchDetailProductionStatusCommand) {
    return Promise.reject(databaseUnavailable());
  }
}

function databaseUnavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
