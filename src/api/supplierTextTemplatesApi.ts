import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CreateSupplierTextTemplateBody,
  MySupplierTextTemplatesListDto,
  SupplierTextTemplateCommandResultDto,
  SupplierTextTemplateDefaultBody,
  SupplierTextTemplatesListDto,
  SupplierTextTemplateVersionBody,
  UpdateSupplierTextTemplateBody,
  VisibleSupplierTextTemplates,
} from './types/supplierTextTemplatesApi.types';

const shared = apiRoutes.procurement.supplierTextTemplates;
const mine = apiRoutes.procurement.mySupplierTextTemplates;

/** Доменный 404 личных шаблонов; любой другой 404 — «маршрута нет» (backend без личных шаблонов). */
export const TEMPLATE_NOT_FOUND_CODE = 'SUPPLIER_TEXT_TEMPLATE_NOT_FOUND';

export function isRouteMissing(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  return e?.status === 404 && e.code !== TEMPLATE_NOT_FOUND_CODE;
}

/**
 * Шаблоны текста поставщику. Чтение: маршрут личных шаблонов, а если backend его не знает (откат) — прежний маршрут,
 * только общие и только чтение. ВСЕ команды — только на маршрут личных шаблонов: на прежний маршрут записи нет
 * никогда, иначе после отката backend личный текст сохранился бы как общий (plan review R2-1).
 */
export const supplierTextTemplatesApi = {
  async listVisible(options?: { signal?: AbortSignal }): Promise<VisibleSupplierTextTemplates> {
    try {
      const result = await httpClient.get<MySupplierTextTemplatesListDto>(mine.list, options);
      return { templates: result.templates, editable: result.canEditOwn === true, defaultRevision: result.defaultRevision ?? 0 };
    } catch (error) {
      if (!isRouteMissing(error)) throw error;
      const result = await httpClient.get<SupplierTextTemplatesListDto>(shared.list, options);
      return { templates: result.templates.map((template) => ({ ...template, scope: 'shared' as const })), editable: false, defaultRevision: 0 };
    }
  },
  create(body: CreateSupplierTextTemplateBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.post<SupplierTextTemplateCommandResultDto>(mine.list, body);
  },
  update(templateId: number, body: UpdateSupplierTextTemplateBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.patch<SupplierTextTemplateCommandResultDto>(mine.byId(templateId), body);
  },
  // Тело DELETE: commandKey и expectedVersion (Content-Type выставляет httpClient).
  remove(templateId: number, body: SupplierTextTemplateVersionBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.delete<SupplierTextTemplateCommandResultDto>(mine.byId(templateId), { body: JSON.stringify(body) });
  },
  setDefault(templateId: number, body: SupplierTextTemplateDefaultBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.post<SupplierTextTemplateCommandResultDto>(mine.setDefault(templateId), body);
  },
};
