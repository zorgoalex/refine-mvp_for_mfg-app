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

export interface ChangeOrderStatusFromDeadlineCommand {
  source: 'deadline-engine';
  systemActor: {
    type: 'system';
    actorUserId: null;
    actorLabel: 'deadline-engine';
  };
  orderId: number;
  targetOrderStatusId: number;
  deadlineId: string;
  deadlineEventId: string;
  actionRuleId: string;
  ruleVersionId?: string | null;
  ruleConfigSnapshot: object;
  idempotencyKey: string;
  requestId?: string;
  occurredAt: string;
}

export interface ChangeOrderStatusFromDeadlineResult {
  status: 'executed' | 'skipped';
  skipReason?: string | null;
  response: ProductionActionResponseDto;
}

export interface ChangeProductionStatusFromDeadlineCommand {
  source: 'deadline-engine';
  systemActor: {
    type: 'system';
    actorUserId: null;
    actorLabel: 'deadline-engine';
  };
  orderId: number;
  targetProductionStatusId: number;
  productionStatusScope: 'order';
  deadlineId: string;
  deadlineEventId: string;
  actionRuleId: string;
  ruleVersionId?: string | null;
  ruleConfigSnapshot: object;
  idempotencyKey: string;
  requestId?: string;
  occurredAt: string;
}

export interface ChangeProductionStatusFromDeadlineResult {
  status: 'executed' | 'skipped';
  skipReason?: string | null;
  response: ProductionActionResponseDto;
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
  changeOrderStatusFromDeadline(
    command: ChangeOrderStatusFromDeadlineCommand,
  ): Promise<ChangeOrderStatusFromDeadlineResult>;
  changeProductionStatusFromDeadline(
    command: ChangeProductionStatusFromDeadlineCommand,
  ): Promise<ChangeProductionStatusFromDeadlineResult>;
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
