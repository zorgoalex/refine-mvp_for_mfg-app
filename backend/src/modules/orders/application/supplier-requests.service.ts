import { auditService } from '../../../common/audit/audit.service';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  CreateSupplierRequestDraftsCommand,
  CreateSupplierRequestDraftsResultDto,
  SupplierRequestCardDto,
  SupplierRequestCommandResultDto,
  SupplierRequestsListQuery,
  SupplierRequestsListResponseDto,
  TransitionSupplierRequestCommand,
  UpdateSupplierRequestCommand,
} from './supplier-requests.types';

export interface SupplierRequestsRepositoryPort {
  createDrafts(command: CreateSupplierRequestDraftsCommand): Promise<CreateSupplierRequestDraftsResultDto>;
  list(currentUser: CurrentUser, query: SupplierRequestsListQuery): Promise<SupplierRequestsListResponseDto>;
  getCard(currentUser: CurrentUser, supplierRequestId: number, canManage: boolean): Promise<SupplierRequestCardDto>;
  update(command: UpdateSupplierRequestCommand): Promise<SupplierRequestCommandResultDto>;
  transition(command: TransitionSupplierRequestCommand): Promise<SupplierRequestCommandResultDto>;
}

export interface SupplierRequestsServicePorts {
  repository: SupplierRequestsRepositoryPort;
  permissions?: OrderPermissionCheckerPort;
  /** Пул БД для denied-аудита вне транзакции команды. */
  auditClient?: DatabaseClient;
}

const VIEW = 'procurement.view';
const MANAGE = 'procurement.manage';

/** Заявки поставщикам (§5.5): чтение — procurement.view, команды — procurement.manage (буквальная проверка). */
export class SupplierRequestsService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: SupplierRequestsServicePorts) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  canManage(user: CurrentUser): boolean {
    return this.permissions.canUser(user, MANAGE);
  }

  async list(user: CurrentUser, query: SupplierRequestsListQuery): Promise<SupplierRequestsListResponseDto> {
    this.requireView(user);
    return this.ports.repository.list(user, query);
  }

  async getCard(user: CurrentUser, supplierRequestId: number): Promise<SupplierRequestCardDto> {
    this.requireView(user);
    return this.ports.repository.getCard(user, supplierRequestId, this.canManage(user));
  }

  async createDrafts(command: CreateSupplierRequestDraftsCommand): Promise<CreateSupplierRequestDraftsResultDto> {
    await this.requireCommand(command.currentUser, command.requestId, null);
    return this.ports.repository.createDrafts(command);
  }

  async update(command: UpdateSupplierRequestCommand): Promise<SupplierRequestCommandResultDto> {
    await this.requireCommand(command.currentUser, command.requestId, command.supplierRequestId);
    return this.ports.repository.update(command);
  }

  async transition(command: TransitionSupplierRequestCommand): Promise<SupplierRequestCommandResultDto> {
    await this.requireCommand(command.currentUser, command.requestId, command.supplierRequestId);
    return this.ports.repository.transition(command);
  }

  private requireView(user: CurrentUser): void {
    if (!this.permissions.canUser(user, VIEW)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для заявок поставщикам', { requiredPermissions: [VIEW] });
    }
  }

  /** Команда: нужны оба права (буквально); любой отказ пишется в denied-аудит (CR1-4). */
  private async requireCommand(user: CurrentUser, requestId: string, supplierRequestId: number | null): Promise<void> {
    const missing = ([VIEW, MANAGE] as const).filter((permission) => !this.permissions.canUser(user, permission));
    if (missing.length === 0) return;
    if (this.ports.auditClient) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'procurement.supplier_request_denied',
        entityType: 'supplier_request',
        entityId: supplierRequestId ?? 'new',
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-supplier-requests',
        reason: 'missing_permission',
        requiredPermissions: missing,
        relatedEntities: supplierRequestId === null ? [] : [{ entityType: 'supplier_request', entityId: supplierRequestId }],
      });
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для работы с заявками поставщикам', { requiredPermissions: missing });
  }
}
