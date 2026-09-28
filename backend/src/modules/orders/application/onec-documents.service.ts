import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type {
  AddOnecAllocationCommand,
  OnecAllocationResultDto,
  OnecDocumentCardResponseDto,
  OnecDocumentListQuery,
  OnecDocumentListResponseDto,
  OnecDocumentReadOptions,
  RemoveOnecAllocationCommand,
} from './onec-documents.types';
import type { OrderPermissionCheckerPort } from './order-transaction.types';

export interface OnecDocumentsPort {
  list(user: CurrentUser, query: OnecDocumentListQuery, options: OnecDocumentReadOptions): Promise<OnecDocumentListResponseDto>;
  getCard(user: CurrentUser, documentId: number, options: OnecDocumentReadOptions): Promise<OnecDocumentCardResponseDto>;
  addAllocation(command: AddOnecAllocationCommand): Promise<OnecAllocationResultDto>;
  removeAllocation(command: RemoveOnecAllocationCommand): Promise<OnecAllocationResultDto>;
}

const VIEW = 'procurement.view';
const MANAGE = 'procurement.manage';
const FINANCE = 'finance.view';

/** Документы 1С на экране «Закупки → Документы 1С»: права и сборка опций чтения. */
export class OnecDocumentsService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: {
    documents: OnecDocumentsPort;
    permissions?: OrderPermissionCheckerPort;
    auditClient?: DatabaseClient;
  }) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  readOptions(user: CurrentUser, procurementEnabled: boolean): OnecDocumentReadOptions {
    return { procurementEnabled, canSeeAmounts: this.permissions.canUser(user, FINANCE) };
  }

  async list(user: CurrentUser, query: OnecDocumentListQuery, procurementEnabled: boolean): Promise<OnecDocumentListResponseDto> {
    this.requireView(user);
    return this.ports.documents.list(user, query, this.readOptions(user, procurementEnabled));
  }

  async getCard(user: CurrentUser, documentId: number, procurementEnabled: boolean): Promise<OnecDocumentCardResponseDto> {
    this.requireView(user);
    return this.ports.documents.getCard(user, documentId, this.readOptions(user, procurementEnabled));
  }

  async addAllocation(command: AddOnecAllocationCommand): Promise<OnecAllocationResultDto> {
    await this.requireManage(command.currentUser, command.requestId, command.documentId);
    return this.withFinanceDeniedAudit(command.currentUser, command.requestId, command.documentId,
      () => this.ports.documents.addAllocation(command));
  }

  async removeAllocation(command: RemoveOnecAllocationCommand): Promise<OnecAllocationResultDto> {
    await this.requireManage(command.currentUser, command.requestId, command.documentId);
    return this.withFinanceDeniedAudit(command.currentUser, command.requestId, command.documentId,
      () => this.ports.documents.removeAllocation(command));
  }

  /**
   * Право на оплаты (finance.view) проверяется внутри транзакции команды, когда
   * известен вид документа; её откат забрал бы и запись отказа — поэтому отказ
   * пишется здесь, после отката, через пул.
   */
  private async withFinanceDeniedAudit<T>(
    user: CurrentUser,
    requestId: string,
    documentId: number,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (this.ports.auditClient && isFinanceDenial(error)) {
        await auditService.recordDenied(this.ports.auditClient, {
          event: 'order_resource.onec_allocation_denied',
          entityType: 'onec_document',
          entityId: documentId,
          actorUserId: user.id,
          actorUsername: user.username,
          actorRole: user.role,
          requestId,
          source: 'backend-order-resource-procurement',
          reason: 'missing_finance_permission',
          requiredPermissions: [FINANCE],
          relatedEntities: [{ entityType: 'onec_document', entityId: documentId }],
        });
      }
      throw error;
    }
  }

  private requireView(user: CurrentUser): void {
    if (!this.permissions.canUser(user, VIEW)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для просмотра документов 1С', { requiredPermissions: [VIEW] });
    }
  }

  private async requireManage(user: CurrentUser, requestId: string, documentId: number): Promise<void> {
    if (this.permissions.canUser(user, MANAGE)) return;
    if (this.ports.auditClient) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'order_resource.onec_allocation_denied',
        entityType: 'onec_document',
        entityId: documentId,
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-order-resource-procurement',
        reason: 'missing_permission',
        requiredPermissions: [MANAGE],
        relatedEntities: [{ entityType: 'onec_document', entityId: documentId }],
      });
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для распределения документов 1С', { requiredPermissions: [MANAGE] });
  }
}

function isFinanceDenial(error: unknown): boolean {
  return error instanceof ApiError
    && error.statusCode === 403
    && Array.isArray(error.details?.requiredPermissions)
    && (error.details?.requiredPermissions as unknown[]).includes(FINANCE);
}
