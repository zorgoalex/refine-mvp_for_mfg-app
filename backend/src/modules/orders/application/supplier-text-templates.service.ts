import { ApiError } from '../../../common/errors/api-error';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { PermissionsService } from '../../../permissions/permissions.service';
import type { OrderPermissionCheckerPort } from './order-transaction.types';
import type {
  CreateSupplierTextTemplateCommand,
  SupplierTextTemplateCommandResultDto,
  SupplierTextTemplateDto,
  SupplierTextTemplatesListDto,
  TemplateVersionCommand,
  UpdateSupplierTextTemplateCommand,
} from './supplier-text-templates.types';

export interface SupplierTextTemplatesRepositoryPort {
  list(): Promise<SupplierTextTemplateDto[]>;
  create(command: CreateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto>;
  update(command: UpdateSupplierTextTemplateCommand): Promise<SupplierTextTemplateCommandResultDto>;
  remove(command: TemplateVersionCommand): Promise<SupplierTextTemplateCommandResultDto>;
  setDefault(command: TemplateVersionCommand): Promise<SupplierTextTemplateCommandResultDto>;
}

const VIEW = 'procurement.view';
const MANAGE = 'procurement.manage';

/** Шаблоны текста заявки поставщику (план 2026-10-02 §4): чтение — procurement.view, правка — + procurement.manage. */
export class SupplierTextTemplatesService {
  private readonly permissions: OrderPermissionCheckerPort;

  constructor(private readonly ports: { repository: SupplierTextTemplatesRepositoryPort; permissions?: OrderPermissionCheckerPort; auditClient?: DatabaseClient }) {
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async list(user: CurrentUser): Promise<SupplierTextTemplatesListDto> {
    if (!this.permissions.canUser(user, VIEW)) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для заявок поставщикам', { requiredPermissions: [VIEW] });
    }
    return { templates: await this.ports.repository.list(), canManage: this.permissions.canUser(user, MANAGE) };
  }

  async create(command: CreateSupplierTextTemplateCommand) {
    await this.requireManage(command.currentUser, command.requestId, null);
    return this.ports.repository.create(command);
  }

  async update(command: UpdateSupplierTextTemplateCommand) {
    await this.requireManage(command.currentUser, command.requestId, command.templateId);
    return this.ports.repository.update(command);
  }

  async remove(command: TemplateVersionCommand) {
    await this.requireManage(command.currentUser, command.requestId, command.templateId);
    return this.ports.repository.remove(command);
  }

  async setDefault(command: TemplateVersionCommand) {
    await this.requireManage(command.currentUser, command.requestId, command.templateId);
    return this.ports.repository.setDefault(command);
  }

  /** Буквальная проверка обоих прав; отказ — denied-аудит. */
  private async requireManage(user: CurrentUser, requestId: string, templateId: number | null): Promise<void> {
    const missing = ([VIEW, MANAGE] as const).filter((permission) => !this.permissions.canUser(user, permission));
    if (missing.length === 0) return;
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
        requiredPermissions: missing,
        relatedEntities: templateId === null ? [] : [{ entityType: 'supplier_text_template', entityId: templateId }],
      });
    }
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для шаблонов текста поставщику', { requiredPermissions: missing });
  }
}
