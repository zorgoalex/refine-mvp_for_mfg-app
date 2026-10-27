import { ApiError } from '../../../common/errors/api-error';
import type {
  ClientPhoneRepositoryPort,
  CreateClientPhoneCommand,
  DeleteClientPhoneCommand,
  ReplaceClientPhoneSetCommand,
  UpdateClientPhoneCommand,
} from '../application/client-phone.types';

export class UnavailableClientPhoneRepository implements ClientPhoneRepositoryPort {
  createClientPhone(_command: CreateClientPhoneCommand) {
    return Promise.reject(databaseUnavailable());
  }

  updateClientPhone(_command: UpdateClientPhoneCommand) {
    return Promise.reject(databaseUnavailable());
  }

  deleteClientPhone(_command: DeleteClientPhoneCommand) {
    return Promise.reject(databaseUnavailable());
  }

  replaceClientPhoneSet(_command: ReplaceClientPhoneSetCommand) {
    return Promise.reject(databaseUnavailable());
  }
}

function databaseUnavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}
