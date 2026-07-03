import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  GenerateOrderLabelsInput,
  GenerateDetailLabelsInput,
  DetailLabelsPreview,
  LabelFieldCatalogItem,
  LabelQrTemplate,
  LabelQrTemplateInput,
  LabelTemplate,
  LabelTemplateInput,
  OrderLabelData,
  OrderLabelGeneration,
  OrderLabelsPreview,
  PreviewDetailLabelsInput,
  LatestOrderLabelsPreview,
  PreviewOrderLabelsInput,
  UpdateLabelQrTemplateInput,
  UpdateLabelTemplateInput,
  UpdateOrderLabelDataInput,
} from './types/labelsApi.types';

export const labelsApi = {
  listFields(): Promise<LabelFieldCatalogItem[]> {
    return httpClient.get<LabelFieldCatalogItem[]>(apiRoutes.labels.fields);
  },

  listTemplates(includeInactive = false): Promise<LabelTemplate[]> {
    const query = includeInactive ? '?includeInactive=true' : '';
    return httpClient.get<LabelTemplate[]>(`${apiRoutes.labels.templates}${query}`);
  },

  getTemplate(id: number): Promise<LabelTemplate> {
    return httpClient.get<LabelTemplate>(apiRoutes.labels.template(validateId(id, 'templateId')));
  },

  createTemplate(input: LabelTemplateInput): Promise<LabelTemplate> {
    return httpClient.post<LabelTemplate>(apiRoutes.labels.templates, input);
  },

  updateTemplate(id: number, input: UpdateLabelTemplateInput): Promise<LabelTemplate> {
    return httpClient.put<LabelTemplate>(apiRoutes.labels.template(validateId(id, 'templateId')), input);
  },

  deleteTemplate(id: number, version: number, idempotencyKey: string): Promise<void> {
    return httpClient.delete<void>(apiRoutes.labels.template(validateId(id, 'templateId')), {
      body: JSON.stringify({ version, idempotencyKey }),
    });
  },

  getOrderLabelData(orderId: number, templateId: number): Promise<OrderLabelData> {
    return httpClient.get<OrderLabelData>(
      `${apiRoutes.labels.orderData(validateId(orderId, 'orderId'))}?templateId=${validateId(templateId, 'templateId')}`,
    );
  },

  updateOrderLabelData(orderId: number, input: UpdateOrderLabelDataInput): Promise<OrderLabelData> {
    return httpClient.put<OrderLabelData>(apiRoutes.labels.orderData(validateId(orderId, 'orderId')), input);
  },

  previewOrderLabels(orderId: number, input: PreviewOrderLabelsInput): Promise<OrderLabelsPreview> {
    return httpClient.post<OrderLabelsPreview>(apiRoutes.labels.orderPreview(validateId(orderId, 'orderId')), input);
  },

  generateOrderLabels(orderId: number, input: GenerateOrderLabelsInput): Promise<OrderLabelGeneration> {
    return httpClient.post<OrderLabelGeneration>(apiRoutes.labels.orderGenerate(validateId(orderId, 'orderId')), input);
  },

  previewDetailLabels(input: PreviewDetailLabelsInput): Promise<DetailLabelsPreview> {
    return httpClient.post<DetailLabelsPreview>(apiRoutes.labels.detailPreview, input);
  },

  generateDetailLabels(input: GenerateDetailLabelsInput): Promise<OrderLabelGeneration> {
    return httpClient.post<OrderLabelGeneration>(apiRoutes.labels.detailGenerate, input);
  },

  getLatest(orderId: number): Promise<LatestOrderLabelsPreview> {
    return httpClient.get<LatestOrderLabelsPreview>(apiRoutes.labels.latest(validateId(orderId, 'orderId')));
  },

  async downloadLatest(orderId: number): Promise<{ blob: Blob; fileName: string | null }> {
    const { blob, fileName } = await httpClient.download(apiRoutes.labels.latestExport(validateId(orderId, 'orderId')));
    return { blob, fileName };
  },

  async downloadGeneration(orderId: number, generationId: number): Promise<{ blob: Blob; fileName: string | null }> {
    const { blob, fileName } = await httpClient.download(
      apiRoutes.labels.generationExport(validateId(orderId, 'orderId'), validateId(generationId, 'generationId')),
    );
    return { blob, fileName };
  },

  async downloadDetailGeneration(generationId: number): Promise<{ blob: Blob; fileName: string | null }> {
    const { blob, fileName } = await httpClient.download(
      apiRoutes.labels.detailGenerationExport(validateId(generationId, 'generationId')),
    );
    return { blob, fileName };
  },

  listQrTemplates(includeInactive = false): Promise<LabelQrTemplate[]> {
    const query = includeInactive ? '?includeInactive=true' : '';
    return httpClient.get<LabelQrTemplate[]>(`${apiRoutes.labels.qrTemplates}${query}`);
  },

  createQrTemplate(input: LabelQrTemplateInput): Promise<LabelQrTemplate> {
    return httpClient.post<LabelQrTemplate>(apiRoutes.labels.qrTemplates, input);
  },

  updateQrTemplate(id: number, input: UpdateLabelQrTemplateInput): Promise<LabelQrTemplate> {
    return httpClient.put<LabelQrTemplate>(apiRoutes.labels.qrTemplate(validateId(id, 'qrTemplateId')), input);
  },

  deleteQrTemplate(id: number, version: number, idempotencyKey: string): Promise<void> {
    return httpClient.delete<void>(apiRoutes.labels.qrTemplate(validateId(id, 'qrTemplateId')), {
      body: JSON.stringify({ version, idempotencyKey }),
    });
  },
};

function validateId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}
