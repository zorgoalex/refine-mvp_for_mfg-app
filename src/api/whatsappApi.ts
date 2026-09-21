import { apiRoutes } from "./apiRoutes";
import { httpClient, type RequestOptions } from "./httpClient";
import type {
  WhatsAppAuditDto,
  WhatsAppReplyPreview,
  WhatsAppDeliveryJobDto,
  WhatsAppRuleDto,
  WhatsAppRuleInput,
  WhatsAppStatusDto,
  WhatsAppTemplateDto,
  WhatsAppTemplateInput,
  WhatsAppTechnicalLogQuery,
  WhatsAppTechnicalLogResponse,
} from "./types/whatsappApi.types";

export const whatsappApi = {
  preview: (body: { matchMode: WhatsAppRuleInput['matchMode']; keywords: string[]; body: string; bodyMode: 'text' | 'template'; text: string }) =>
    httpClient.post<WhatsAppReplyPreview>(apiRoutes.whatsapp.preview, body),
  status: () => httpClient.get<WhatsAppStatusDto>(apiRoutes.whatsapp.status),
  qr: async () => (await httpClient.download(apiRoutes.whatsapp.qr)).blob,
  restart: (restrictionConfirmed: boolean) =>
    httpClient.post<unknown>(apiRoutes.whatsapp.restart, {
      confirmed: true,
      restrictionConfirmed,
    }),
  templates: () =>
    httpClient.get<WhatsAppTemplateDto[]>(apiRoutes.whatsapp.templates),
  createTemplate: (body: WhatsAppTemplateInput) =>
    httpClient.post<WhatsAppTemplateDto>(apiRoutes.whatsapp.templates, body),
  updateTemplate: (
    id: number,
    body: Partial<WhatsAppTemplateInput> & { version: number }
  ) =>
    httpClient.patch<WhatsAppTemplateDto>(
      apiRoutes.whatsapp.templateById(id),
      body
    ),
  rules: () => httpClient.get<WhatsAppRuleDto[]>(apiRoutes.whatsapp.rules),
  createRule: (body: WhatsAppRuleInput) =>
    httpClient.post<WhatsAppRuleDto>(apiRoutes.whatsapp.rules, body),
  updateRule: (
    id: number,
    body: Partial<WhatsAppRuleInput> & { version: number }
  ) => httpClient.patch<WhatsAppRuleDto>(apiRoutes.whatsapp.ruleById(id), body),
  queue: () =>
    httpClient.get<WhatsAppDeliveryJobDto[]>(apiRoutes.whatsapp.queue),
  retryJob: (id: number) =>
    httpClient.post<WhatsAppDeliveryJobDto>(
      apiRoutes.whatsapp.retryJob(id),
      {}
    ),
  processNow: () => httpClient.post(apiRoutes.whatsapp.processNow, {}),
  audit: () => httpClient.get<WhatsAppAuditDto[]>(apiRoutes.whatsapp.audit),
  technicalLogs: (query: WhatsAppTechnicalLogQuery = {}, options?: RequestOptions) =>
    httpClient.get<WhatsAppTechnicalLogResponse>(
      withQuery(apiRoutes.whatsapp.technicalLogs, query),
      options,
    ),
  exportTechnicalLogs: (query: WhatsAppTechnicalLogQuery = {}) =>
    httpClient.download(withQuery(apiRoutes.whatsapp.technicalLogsExport, query)),
};

function withQuery(path: string, query: WhatsAppTechnicalLogQuery): string {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, String(value));
  });
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}
