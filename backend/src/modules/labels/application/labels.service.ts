import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { isBuiltInLabelFieldId, isSupportedFieldBinding } from './bazis-field-catalog';
import { LABEL_FIELD_CATALOG, type LabelFieldCatalogItem } from './bazis-field-catalog';
import { validateQrTemplateElement } from './label-template-fields';
import type {
  CreateLabelTemplateCommand,
  DeleteLabelTemplateCommand,
  GetLabelTemplateQuery,
  GetOrderLabelDataQuery,
  GenerateOrderLabelsCommand,
  GenerateDetailLabelsCommand,
  LabelTemplateElementInput,
  LabelTemplateInput,
  LabelsPort,
  LabelsContext,
  LabelTemplateDto,
  ListLabelTemplatesQuery,
  OrderLabelDataDto,
  OrderLabelGenerationDto,
  LatestOrderLabelsPreviewDto,
  OrderLabelsPreviewDto,
  ExportOrderLabelsQuery,
  ExportDetailLabelsQuery,
  DetailLabelsPreviewDto,
  PreviewDetailLabelsCommand,
  PreviewOrderLabelsCommand,
  UpdateOrderLabelDataCommand,
  UpdateLabelTemplateCommand,
} from './labels.types';
import { LabelFieldBindingError } from '../errors/labels.errors';

export interface LabelsServicePorts {
  repo: LabelsPort;
  permissions?: PermissionsService;
}

const VIEW: PermissionName = 'labels.view';
const MANAGE_TEMPLATES: PermissionName = 'labels.manage_templates';
const GENERATE: PermissionName = 'labels.generate';

export class LabelsService {
  private readonly repo: LabelsPort;
  private readonly permissions: PermissionsService;

  constructor(ports: LabelsServicePorts) {
    this.repo = ports.repo;
    this.permissions = ports.permissions ?? new PermissionsService();
  }

  async listTemplates(query: ListLabelTemplatesQuery): Promise<LabelTemplateDto[]> {
    await this.require(query, [VIEW]);
    return this.repo.listTemplates(query);
  }

  async listFields(ctx: LabelsContext): Promise<LabelFieldCatalogItem[]> {
    await this.require(ctx, [VIEW]);
    return [...LABEL_FIELD_CATALOG];
  }

  async getTemplateById(query: GetLabelTemplateQuery): Promise<LabelTemplateDto> {
    await this.require(query, [VIEW], query.id);
    return this.repo.getTemplateById(query);
  }

  async createTemplate(command: CreateLabelTemplateCommand): Promise<LabelTemplateDto> {
    await this.require(command, [MANAGE_TEMPLATES]);
    validateTemplateInput(command.input);
    return this.repo.createTemplate(command);
  }

  async updateTemplate(command: UpdateLabelTemplateCommand): Promise<LabelTemplateDto> {
    await this.require(command, [MANAGE_TEMPLATES], command.id);
    validateTemplateInput(command.input);
    return this.repo.updateTemplate(command);
  }

  async deleteTemplate(command: DeleteLabelTemplateCommand): Promise<void> {
    await this.require(command, [MANAGE_TEMPLATES], command.id);
    return this.repo.deleteTemplate(command);
  }

  async getOrderLabelData(query: GetOrderLabelDataQuery): Promise<OrderLabelDataDto> {
    await this.require(query, [VIEW, GENERATE, MANAGE_TEMPLATES], query.orderId, 'order');
    return this.repo.getOrderLabelData(query);
  }

  async updateOrderLabelData(command: UpdateOrderLabelDataCommand): Promise<OrderLabelDataDto> {
    await this.require(command, [GENERATE, MANAGE_TEMPLATES], command.orderId, 'order');
    return this.repo.updateOrderLabelData(command);
  }

  async previewOrderLabels(command: PreviewOrderLabelsCommand): Promise<OrderLabelsPreviewDto> {
    await this.require(command, [VIEW, GENERATE, MANAGE_TEMPLATES], command.orderId, 'order');
    return this.repo.previewOrderLabels(command);
  }

  async generateOrderLabels(command: GenerateOrderLabelsCommand): Promise<OrderLabelGenerationDto> {
    await this.require(command, [GENERATE], command.orderId, 'order');
    return this.repo.generateOrderLabels(command);
  }

  async previewDetailLabels(command: PreviewDetailLabelsCommand): Promise<DetailLabelsPreviewDto> {
    await this.require(command, [VIEW, GENERATE, MANAGE_TEMPLATES]);
    return this.repo.previewDetailLabels(command);
  }

  async generateDetailLabels(command: GenerateDetailLabelsCommand): Promise<OrderLabelGenerationDto> {
    await this.require(command, [GENERATE]);
    return this.repo.generateDetailLabels(command);
  }

  async getLatestOrderLabelsPreview(query: ExportOrderLabelsQuery): Promise<LatestOrderLabelsPreviewDto> {
    await this.require(query, [VIEW, GENERATE], query.orderId, 'order');
    return this.repo.getLatestOrderLabelsPreview(query);
  }

  async exportOrderLabels(query: ExportOrderLabelsQuery): Promise<{ filename: string; contentType: string; body: Buffer }> {
    await this.require(query, [GENERATE], query.orderId, 'order');
    return this.repo.exportOrderLabels(query);
  }

  async exportDetailLabels(query: ExportDetailLabelsQuery): Promise<{ filename: string; contentType: string; body: Buffer }> {
    await this.require(query, [GENERATE]);
    return this.repo.exportDetailLabels(query);
  }

  private async require(
    ctx: LabelsContext,
    permissions: PermissionName[],
    targetId?: number,
    targetEntityType: 'label_template' | 'order' = 'label_template',
  ): Promise<void> {
    if (this.permissions.canUserAny(ctx.currentUser, permissions)) {
      return;
    }
    void this.repo
      .recordPermissionDenied({
        currentUser: ctx.currentUser,
        requiredPermissions: permissions,
        requestId: ctx.requestId,
        targetId,
        targetEntityType,
      })
      .catch(() => undefined);
    throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
      requiredPermissions: permissions,
    });
  }
}

export function validateTemplateInput(input: LabelTemplateInput): void {
  const customFieldSchema = input.customFieldSchema;
  validateCustomFieldMappings(customFieldSchema);
  for (const [index, element] of input.elements.entries()) {
    validateElementFieldBinding(element, customFieldSchema, index);
  }
}

function validateCustomFieldMappings(customFieldSchema: Record<string, unknown>): void {
  for (const schema of Object.values(customFieldSchema)) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue;
    const sourceField = (schema as Record<string, unknown>).sourceField;
    if (sourceField == null || sourceField === '') continue;
    if (typeof sourceField !== 'string' || !isBuiltInLabelFieldId(sourceField)) {
      throw new LabelFieldBindingError(String(sourceField));
    }
  }
}

function validateElementFieldBinding(
  element: LabelTemplateElementInput,
  customFieldSchema: Record<string, unknown>,
  index: number,
): void {
  if (element.kind === 'qr') {
    validateQrTemplateElement(element, customFieldSchema, index);
    return;
  }
  const binding = element.sourceField?.trim();
  if (!binding) {
    if (element.kind === 'text' && !element.staticText?.trim()) {
      throw new ApiError(422, 'LABEL_TEXT_ELEMENT_EMPTY', 'Text label element requires text or field binding', {
        elementIndex: index,
      });
    }
    return;
  }
  if (!isSupportedFieldBinding(binding, customFieldSchema)) {
    throw new LabelFieldBindingError(binding);
  }
}

export function actorId(user: CurrentUser): number | null {
  const parsed = Number(user.id);
  return Number.isInteger(parsed) ? parsed : null;
}
