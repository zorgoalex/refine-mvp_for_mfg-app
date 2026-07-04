import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName } from '../../../permissions/permissions';
import { PermissionsService } from '../../../permissions/permissions.service';
import { isBuiltInLabelFieldId, isSupportedFieldBinding } from './bazis-field-catalog';
import { LABEL_FIELD_CATALOG, type LabelFieldCatalogItem } from './bazis-field-catalog';
import { validateQrTemplateElement, extractLabelTemplateFieldIds } from './label-template-fields';
import { compileQrTemplate, parseQrPayload, parseQrPayloadRight } from './scan/qr-template-parser';
import { scoreCandidate, rankCandidates } from './scan/scan-ranking';
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
  LabelQrTemplateDto,
  LabelQrTemplateInput,
  ListLabelQrTemplatesQuery,
  CreateLabelQrTemplateCommand,
  UpdateLabelQrTemplateCommand,
  DeleteLabelQrTemplateCommand,
  ScanResolveCommand,
  ScanResolveResult,
  ScanSearchInput,
  ScanCandidateRow,
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
  private qrTemplateCache: { at: number; templates: string[] } | null = null;
  private static readonly QR_TEMPLATE_CACHE_MS = 45_000;

  // Маппинг field id (semantic id из bazis-field-catalog) -> ключ ScanSearchInput.
  private static readonly SCAN_FIELD_TO_INPUT: Record<string, keyof ScanSearchInput> = {
    'detail.detail_id': 'detailId',
    'detail.order_id': 'orderId',
    'order.order_id': 'orderId',
    'order.order_name': 'orderName',
    'bazis.order_number': 'orderName',
    'detail.detail_number': 'detailNumber',
    'bazis.position_in_product': 'detailNumber',
    'bazis.position': 'detailNumber',
  };

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

  async listQrTemplates(query: ListLabelQrTemplatesQuery): Promise<LabelQrTemplateDto[]> {
    await this.require(query, [VIEW], undefined, 'label_qr_template');
    return this.repo.listQrTemplates(query);
  }

  async createQrTemplate(command: CreateLabelQrTemplateCommand): Promise<LabelQrTemplateDto> {
    await this.require(command, [MANAGE_TEMPLATES], undefined, 'label_qr_template');
    validateQrTemplateInput(command.input);
    return this.repo.createQrTemplate(command);
  }

  async updateQrTemplate(command: UpdateLabelQrTemplateCommand): Promise<LabelQrTemplateDto> {
    await this.require(command, [MANAGE_TEMPLATES], command.id, 'label_qr_template');
    validateQrTemplateInput(command.input);
    return this.repo.updateQrTemplate(command);
  }

  async deleteQrTemplate(command: DeleteLabelQrTemplateCommand): Promise<void> {
    await this.require(command, [MANAGE_TEMPLATES], command.id, 'label_qr_template');
    return this.repo.deleteQrTemplate(command);
  }

  async scanResolve(cmd: ScanResolveCommand): Promise<ScanResolveResult> {
    await this.require(cmd, [VIEW]);
    const payload = (cmd.payload ?? '').trim();
    if (!payload) {
      throw new ApiError(422, 'LABEL_SCAN_PAYLOAD_EMPTY', 'Пустая строка сканирования', {});
    }

    // Пробуем ВСЕ шаблоны (не первый совпавший) + ВСЕГДА добавляем fallback-
    // интерпретацию целой строки. Причина: значение поля может содержать
    // разделитель (имя заказа с «|») — единственный «успешный» парс тогда ложный;
    // слияние интерпретаций с ранжированием защищает от уверенно-неверного роутинга.
    const templates = await this.getActiveQrTemplates();
    const interpretations: Array<{ input: ScanSearchInput; parsed: Record<string, string> | null; matchedBy: string }> = [];

    const seen = new Set<string>(); // dedupe интерпретаций ГЛОБАЛЬНО по всем шаблонам
    for (const tpl of templates) {
      const compiled = compileQrTemplate(tpl);
      if (!compiled) continue;
      // ДВЕ интерпретации на шаблон: лево- и право-якорная (право-якорная
      // восстанавливает имя заказа, содержащее разделитель — Codex R2).
      const attempts = [parseQrPayload(payload, compiled), parseQrPayloadRight(payload, compiled)];
      for (const attempt of attempts) {
        if (!attempt || Object.keys(attempt).length === 0) continue;
        const dedupeKey = JSON.stringify(attempt);
        if (seen.has(dedupeKey)) continue; // на чистых строках парсы совпадают
        seen.add(dedupeKey);
        const input: ScanSearchInput = {};
        const bazisFields: Record<string, string> = {};
        for (const [fieldId, value] of Object.entries(attempt)) {
          const key = LabelsService.SCAN_FIELD_TO_INPUT[fieldId];
          if (key === 'orderName') {
            input.orderName = value;
          } else if (key === 'detailId' || key === 'orderId' || key === 'detailNumber') {
            const num = Number(value);
            if (Number.isFinite(num)) input[key] = num;
          }
          if (fieldId.startsWith('bazis.')) {
            // ключ снапшота: см. toSnapshotKey — normalизация в одном месте.
            bazisFields[this.toSnapshotKey(fieldId)] = value;
          }
        }
        if (Object.keys(bazisFields).length > 0) input.bazisFields = bazisFields;
        if (input.detailId != null || input.orderId != null || input.orderName || input.bazisFields) {
          interpretations.push({ input, parsed: attempt, matchedBy: `qr-template:${tpl}` });
        }
      }
    }

    // Fallback всегда: целое число = ID заказа, иначе имя заказа целиком.
    const asNumber = Number(payload);
    const fallbackInput: ScanSearchInput =
      Number.isInteger(asNumber) && asNumber > 0 ? { orderId: asNumber } : { orderName: payload };
    interpretations.push({ input: fallbackInput, parsed: null, matchedBy: 'fallback-fields' });

    // Слияние по detailId: максимум score; каждая запись помнит СВОЮ интерпретацию
    // (matchedBy + parsed) — `parsed` в ответе обязан быть парсом интерпретации,
    // породившей ПОБЕДИВШЕГО кандидата, а не первым попавшимся (Codex R3:
    // для 'A|B|60084|1' победит право-якорная → parsed.orderName='A|B', не 'A').
    type Merged = ScanCandidateRow & { score: number; matchedBy: string; parsed: Record<string, string> | null };
    // Интерпретации независимы — гоняем запросы ПАРАЛЛЕЛЬНО (последовательные
    // await складывали латентности и давали многосекундный скан).
    const perInterpretation = await Promise.all(
      interpretations.map(async (it) => ({ it, rows: await this.repo.findScanCandidates(it.input) })),
    );
    const byDetail = new Map<number, Merged>();
    for (const { it, rows } of perInterpretation) {
      for (const row of rows) {
        const score = scoreCandidate(row.matchedFields);
        const existing = byDetail.get(row.detailId);
        if (!existing || score > existing.score) {
          byDetail.set(row.detailId, { ...row, score, matchedBy: it.matchedBy, parsed: it.parsed });
        }
      }
    }
    const ranked = rankCandidates([...byDetail.values()]);
    const parsed = ranked[0]?.parsed ?? interpretations.find((i) => i.parsed)?.parsed ?? null;
    const candidates = ranked.map(({ parsed: _drop, ...candidate }) => candidate);
    return { candidates, parsed, templatesTried: templates.length };
  }

  private async getActiveQrTemplates(): Promise<string[]> {
    const now = Date.now();
    if (this.qrTemplateCache && now - this.qrTemplateCache.at < LabelsService.QR_TEMPLATE_CACHE_MS) {
      return this.qrTemplateCache.templates;
    }
    const templates = await this.repo.listActiveQrTemplateStrings();
    this.qrTemplateCache = { at: now, templates };
    return templates;
  }

  private toSnapshotKey(fieldId: string): string {
    // Формат ключей bazis_fields ВЕРИФИЦИРОВАН по write-path:
    // backend/src/modules/labels/adapters/pg-labels-repository.ts:615
    // (`{ ...(before?.bazis_fields ?? {}), ...(row.bazisFields ?? {}) }` — merge
    // без трансформации ключей) + :1484 (`bazisFields: row.bazis_fields ?? {}`
    // на чтении — тоже без трансформации) + FE
    // src/pages/orders/components/labels/OrderLabelDataEditor.tsx (спреды
    // detail.bazisFields как есть, точечно правит только 'bazis.comment') +
    // backend/src/modules/labels/application/label-row-builder.ts:76-92
    // (canonical ключи вида 'bazis.order_number', 'bazis.comment', ...).
    // Вывод: ключи order_label_detail_data.bazis_fields ВСЕГДА несут namespace
    // 'bazis.' — идентичный формату fieldId из qr-template-parser. Никакой
    // трансформации не требуется.
    return fieldId;
  }

  private async require(
    ctx: LabelsContext,
    permissions: PermissionName[],
    targetId?: number,
    targetEntityType: 'label_template' | 'order' | 'label_qr_template' = 'label_template',
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
  validateQrElementNames(input.elements);
}

export function validateQrTemplateInput(input: LabelQrTemplateInput): void {
  if (!input.contentTemplate.trim()) {
    throw new ApiError(422, 'LABEL_QR_TEMPLATE_EMPTY', 'QR template content is required', {});
  }
  for (const fieldId of extractLabelTemplateFieldIds(input.contentTemplate)) {
    if (!isSupportedFieldBinding(fieldId, {})) {
      throw new LabelFieldBindingError(fieldId); // maps to 422 LABEL_FIELD_BINDING_INVALID
    }
  }
}

export function validateQrElementNames(elements: LabelTemplateElementInput[]): void {
  const seen = new Set<string>();
  for (const [index, element] of elements.entries()) {
    if (element.kind !== 'qr') continue;
    const name = String((element.style as Record<string, unknown> | undefined)?.qrName ?? '').trim();
    if (!name) {
      throw new ApiError(422, 'LABEL_QR_NAME_REQUIRED', 'QR element requires a name', { elementIndex: index });
    }
    if (seen.has(name.toLowerCase())) {
      throw new ApiError(422, 'LABEL_QR_NAME_DUPLICATE', 'QR names must be unique within a label', { elementIndex: index, name });
    }
    seen.add(name.toLowerCase());
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
