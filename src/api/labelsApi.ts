import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  GenerateOrderLabelsInput,
  GenerateDetailLabelsInput,
  DetailLabelsPreview,
  LabelFieldCatalogItem,
  LabelOcrTemplate,
  LabelOcrTemplateInput,
  LabelQrTemplate,
  LabelQrTemplateInput,
  LabelRendererCapabilities,
  LabelTemplate,
  LabelTemplateInput,
  OcrPreviewResult,
  OcrTemplateRule,
  OcrTestResult,
  OrderLabelData,
  OrderLabelGeneration,
  OrderLabelCutMapOptions,
  OrderLabelsPreview,
  PreviewDetailLabelsInput,
  LatestOrderLabelsPreview,
  PreviewOrderLabelsInput,
  ScanResolveResult,
  UpdateLabelOcrTemplateInput,
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
    return httpClient.get<LabelTemplate[]>(`${apiRoutes.labels.templates}${query}`, { cache: 'no-store' });
  },

  getRendererCapabilities(): Promise<LabelRendererCapabilities> {
    return httpClient.get<LabelRendererCapabilities>(apiRoutes.labels.rendererCapabilities, { cache: 'no-store' });
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

  listOrderCutMapOptions(orderId: number, telegramCutMapFallbackVersion?: 'v1'): Promise<OrderLabelCutMapOptions> {
    const query = telegramCutMapFallbackVersion
      ? `?telegramCutMapFallbackVersion=${telegramCutMapFallbackVersion}`
      : '';
    return httpClient.get<OrderLabelCutMapOptions>(
      `${apiRoutes.labels.orderCutMapOptions(validateId(orderId, 'orderId'))}${query}`,
      { cache: 'no-store' },
    );
  },

  previewDetailLabels(input: PreviewDetailLabelsInput): Promise<DetailLabelsPreview> {
    return httpClient.post<DetailLabelsPreview>(apiRoutes.labels.detailPreview, input);
  },

  generateDetailLabels(input: GenerateDetailLabelsInput): Promise<OrderLabelGeneration> {
    return httpClient.post<OrderLabelGeneration>(apiRoutes.labels.detailGenerate, input);
  },

  async getLatest(orderId: number): Promise<LatestOrderLabelsPreview | null> {
    const latest = await httpClient.get<LatestOrderLabelsPreview | null | undefined>(
      apiRoutes.labels.latest(validateId(orderId, 'orderId')),
    );
    return latest ?? null;
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

  scanResolve(payload: string, source: 'qr' | 'manual'): Promise<ScanResolveResult> {
    return httpClient.post<ScanResolveResult>(apiRoutes.labels.scanResolve(), { payload, source });
  },

  // FormData body: httpClient's jsonBody() passes FormData through as-is and
  // buildRequestInit() skips the Content-Type header for it, so the browser
  // sets the multipart boundary itself (same pattern as vlmApi.upload).
  scanResolveImage(file: File | Blob): Promise<ScanResolveResult> {
    const formData = new FormData();
    formData.append('file', file);
    // Жёсткий клиентский таймаут: без него зависший аплоад/прокси = вечный
    // спиннер (пойман на живом фото 2026-07-05). 30с > серверных 20с.
    return httpClient.post<ScanResolveResult>(apiRoutes.labels.scanResolveImage(), formData, {
      signal: AbortSignal.timeout(30_000),
    });
  },

  listOcrTemplates(includeInactive = false): Promise<LabelOcrTemplate[]> {
    const query = includeInactive ? '?includeInactive=true' : '';
    return httpClient.get<LabelOcrTemplate[]>(`${apiRoutes.labels.ocrTemplates}${query}`);
  },

  createOcrTemplate(input: LabelOcrTemplateInput): Promise<LabelOcrTemplate> {
    return httpClient.post<LabelOcrTemplate>(apiRoutes.labels.ocrTemplates, input);
  },

  updateOcrTemplate(id: number, input: UpdateLabelOcrTemplateInput): Promise<LabelOcrTemplate> {
    return httpClient.put<LabelOcrTemplate>(apiRoutes.labels.ocrTemplate(validateId(id, 'ocrTemplateId')), input);
  },

  deleteOcrTemplate(id: number, version: number, idempotencyKey: string): Promise<void> {
    return httpClient.delete<void>(apiRoutes.labels.ocrTemplate(validateId(id, 'ocrTemplateId')), {
      body: JSON.stringify({ version, idempotencyKey }),
    });
  },

  // FormData body, same rationale as scanResolveImage above.
  previewOcrLabel(file: File | Blob): Promise<OcrPreviewResult> {
    const formData = new FormData();
    formData.append('file', file);
    return httpClient.post<OcrPreviewResult>(apiRoutes.labels.ocrTemplatePreview(), formData, {
      signal: AbortSignal.timeout(30_000),
    });
  },

  testOcrTemplate(file: File | Blob, rules: OcrTemplateRule[]): Promise<OcrTestResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('rules', JSON.stringify(rules));
    return httpClient.post<OcrTestResult>(apiRoutes.labels.ocrTemplateTest(), formData, {
      signal: AbortSignal.timeout(30_000),
    });
  },
};

function validateId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}
