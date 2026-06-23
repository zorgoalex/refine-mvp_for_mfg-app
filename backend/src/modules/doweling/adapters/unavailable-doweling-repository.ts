import type { CreateDowelingOrderResponseDto } from '../dto/doweling.dto';
import type { CreateDowelingOrderCommand, DowelingRepositoryPort } from '../application/doweling.types';
import { DowelingDatabaseUnavailableError } from '../errors/doweling.errors';

// Selected when database.isConfigured is false. DB-outage 503 (DATABASE_UNAVAILABLE) — distinct from
// the controller's flag-off 503 (SERVICE_UNAVAILABLE). Mirror unavailable-client-phone-repository.ts.
export class UnavailableDowelingRepository implements DowelingRepositoryPort {
  createDowelingOrder(_command: CreateDowelingOrderCommand): Promise<CreateDowelingOrderResponseDto> {
    return Promise.reject(new DowelingDatabaseUnavailableError());
  }
}
