import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ChangeOrderStatusRequestDto,
  MoveCalendarDateRequestDto,
  ProductionActionResponseDto,
  ProductionStageEventRequestDto,
} from '../dto/production-action.dto';

export interface MoveCalendarDateCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: MoveCalendarDateRequestDto;
  requestId?: string;
}

export interface ChangeOrderStatusCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: ChangeOrderStatusRequestDto;
  requestId?: string;
}

export interface ActivateProductionStageCommand {
  currentUser: CurrentUser;
  orderId: number;
  productionStatusId: number;
  dto: ProductionStageEventRequestDto;
  requestId?: string;
}

export interface DeactivateProductionStageCommand {
  currentUser: CurrentUser;
  orderId: number;
  productionStatusId: number;
  dto: ProductionStageEventRequestDto;
  requestId?: string;
}

export interface ProductionActionRepositoryPort {
  moveCalendarDate(command: MoveCalendarDateCommand): Promise<ProductionActionResponseDto>;
  changeOrderStatus(command: ChangeOrderStatusCommand): Promise<ProductionActionResponseDto>;
  activateProductionStage(
    command: ActivateProductionStageCommand,
  ): Promise<ProductionActionResponseDto>;
  deactivateProductionStage(
    command: DeactivateProductionStageCommand,
  ): Promise<ProductionActionResponseDto>;
}
