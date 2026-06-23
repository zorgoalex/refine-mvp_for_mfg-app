import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CreateDowelingOrderRequestDto,
  CreateDowelingOrderResponseDto,
} from '../dto/doweling.dto';

export interface CreateDowelingOrderCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dto: CreateDowelingOrderRequestDto;
}

export interface DowelingRepositoryPort {
  createDowelingOrder(command: CreateDowelingOrderCommand): Promise<CreateDowelingOrderResponseDto>;
}
