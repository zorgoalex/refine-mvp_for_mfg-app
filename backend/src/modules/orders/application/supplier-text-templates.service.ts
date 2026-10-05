import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  CreateSupplierTextTemplateCommand,
  MySupplierTextTemplatesListDto,
  SetDefaultTemplateCommand,
  SupplierTextTemplateCommandResultDto,
  SupplierTextTemplateDto,
  SupplierTextTemplatesListDto,
  TemplateVersionCommand,
  UpdateSupplierTextTemplateCommand,
  VisibleSupplierTextTemplatesDto,
} from './supplier-text-templates.types';

export interface SupplierTextTemplatesRepositoryPort {
  listShared(): Promise<SupplierTextTemplateDto[]>;
  listVisible(currentUser: CurrentUser): Promise<VisibleSupplierTextTemplatesDto>;
  create(command: CreateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto>;
  update(command: UpdateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto>;
  remove(command: TemplateVersionCommand): Promise<SupplierTextTemplateCommandResultDto>;
  setDefault(command: SetDefaultTemplateCommand): Promise<SupplierTextTemplateCommandResultDto>;
}

const VIEW = 'procurement.view';

/**
 * Шаблоны текста заявки поставщику (план 2026-10-04): общие — только чтение, личные видит и ведёт их владелец.
 * И чтение, и команды над личными шаблонами — право `procurement.view` (личные данные пользователя, заявки не меняют).
 */
export class SupplierTextTemplatesService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: { repository: SupplierTextTemplatesRepositoryPort; permissions?: OrderPermissionCheckerPort; auditClient?: DatabaseClient }) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  /** Прежний маршрут: только общие шаблоны, правка недоступна. */
  async listShared(user: CurrentUser): Promise<SupplierTextTemplatesListDto> {
    this.requireRead(user);
    return { templates: await this.ports.repository.listShared(), canManage: false };
  }

  async listMine(user: CurrentUser): Promise<MySupplierTextTemplatesListDto> {
    this.requireRead(user);
    return { ...(await this.ports.repository.listVisible(user)), canEditOwn: true };
  }

  async create(command: CreateSupplierTextTemplateCommand) {
    await this.requireCommand(command.currentUser, command.requestId, null);
    return this.ports.repository.create(command);
  }

  async update(command: UpdateSupplierTextTemplateCommand) {
    await this.requireCommand(command.currentUser, command.requestId, command.templateId);
    return this.ports.repository.update(command);
  }

  async remove(command: TemplateVersionCommand) {
    await this.requireCommand(command.currentUser, command.requestId, command.templateId);
    return this.ports.repository.remove(command);
  }

  async setDefault(command: SetDefaultTemplateCommand) {
    await this.requireCommand(command.currentUser, command.requestId, command.templateId);
    return this.ports.repository.setDefault(command);
  }

  private requireRead(user: CurrentUser): void {
    if (!this.permissions.canUser(user, VIEW)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для заявок поставщикам', { requiredPermissions: [VIEW] });
    }
  }

  /** Буквальная проверка права; отказ — denied-аудит. */
  private async requireCommand(user: CurrentUser, requestId: string, templateId: number | null): Promise<void> {
    if (this.permissions.canUser(user, VIEW)) return;
    if (this.ports.auditClient) {
      await auditService.recordDenied(this.ports.auditClient, {
        event: 'procurement.supplier_text_template_denied',
        entityType: 'supplier_text_template',
        entityId: templateId ?? 'new',
        actorUserId: user.id,
        actorUsername: user.username,
        actorRole: user.role,
        requestId,
        source: 'backend-supplier-text-templates',
        reason: 'missing_permission',
        requiredPermissions: [VIEW],
        relatedEntities: templateId === null ? [] : [{ entityType: 'supplier_text_template', entityId: templateId }],
      });
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для шаблонов текста поставщику', { requiredPermissions: [VIEW] });
  }
}
