import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CreateSupplierTextTemplateBody,
  SupplierTextTemplateCommandResultDto,
  SupplierTextTemplatesListDto,
  SupplierTextTemplateVersionBody,
  UpdateSupplierTextTemplateBody,
} from './types/supplierTextTemplatesApi.types';

const routes = apiRoutes.procurement.supplierTextTemplates;

export const supplierTextTemplatesApi = {
  list(options?: { signal?: AbortSignal }): Promise<SupplierTextTemplatesListDto> {
    return httpClient.get<SupplierTextTemplatesListDto>(routes.list, options);
  },
  create(body: CreateSupplierTextTemplateBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.post<SupplierTextTemplateCommandResultDto>(routes.list, body);
  },
  update(templateId: number, body: UpdateSupplierTextTemplateBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.patch<SupplierTextTemplateCommandResultDto>(routes.byId(templateId), body);
  },
  // Тело DELETE: commandKey и expectedVersion (Content-Type выставляет httpClient).
  remove(templateId: number, body: SupplierTextTemplateVersionBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.delete<SupplierTextTemplateCommandResultDto>(routes.byId(templateId), { body: JSON.stringify(body) });
  },
  setDefault(templateId: number, body: SupplierTextTemplateVersionBody): Promise<SupplierTextTemplateCommandResultDto> {
    return httpClient.post<SupplierTextTemplateCommandResultDto>(routes.setDefault(templateId), body);
  },
};
