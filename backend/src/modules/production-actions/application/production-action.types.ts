import type { CurrentUser } from '../../../permissions/current-user';
import type {
  ChangeOrderStatusRequestDto,
  ChangePaymentStatusRequestDto,
  ChangeProductionStatusRequestDto,
  DetailProductionStageEventRequestDto,
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

export interface ChangePaymentStatusCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: ChangePaymentStatusRequestDto;
  requestId?: string;
}

export interface ChangeProductionStatusCommand {
  currentUser: CurrentUser;
  orderId: number;
  dto: ChangeProductionStatusRequestDto;
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

export interface ActivateDetailProductionStageCommand {
  currentUser: CurrentUser;
  detailId: number;
  productionStatusId: number;
  dto: DetailProductionStageEventRequestDto;
  requestId?: string;
}

export interface ProductionActionRepositoryPort {
  moveCalendarDate(command: MoveCalendarDateCommand): Promise<ProductionActionResponseDto>;
  changeOrderStatus(command: ChangeOrderStatusCommand): Promise<ProductionActionResponseDto>;
  changePaymentStatus(command: ChangePaymentStatusCommand): Promise<ProductionActionResponseDto>;
  changeProductionStatus(
    command: ChangeProductionStatusCommand,
  ): Promise<ProductionActionResponseDto>;
  activateProductionStage(
    command: ActivateProductionStageCommand,
  ): Promise<ProductionActionResponseDto>;
  deactivateProductionStage(
    command: DeactivateProductionStageCommand,
  ): Promise<ProductionActionResponseDto>;
  activateDetailProductionStage(
    command: ActivateDetailProductionStageCommand,
  ): Promise<ProductionActionResponseDto>;
}
