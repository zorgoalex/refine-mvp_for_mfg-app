import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CreateDowelingOrderRequestDto,
  CreateDowelingOrderResponseDto,
  UpdateDowelingOrderRequestDto,
  UpdateDowelingOrderResponseDto,
} from '../dto/doweling.dto';

export interface CreateDowelingOrderCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dto: CreateDowelingOrderRequestDto;
  /** Route POST /bazis/cards: the client is mandatory (given or from the order). The legacy route allows none. */
  clientRequired?: boolean;
}

export interface UpdateDowelingOrderCommand {
  currentUser: CurrentUser;
  requestId?: string;
  dowelingOrderId: number;
  dto: UpdateDowelingOrderRequestDto;
}

export interface DowelingRepositoryPort {
  createDowelingOrder(command: CreateDowelingOrderCommand): Promise<CreateDowelingOrderResponseDto>;
  updateDowelingOrder(command: UpdateDowelingOrderCommand): Promise<UpdateDowelingOrderResponseDto>;
}
