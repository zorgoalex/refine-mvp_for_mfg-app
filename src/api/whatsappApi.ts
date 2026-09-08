import { apiRoutes } from "./apiRoutes";
import { httpClient } from "./httpClient";
import type {
  WhatsAppAuditDto,
  WhatsAppDeliveryJobDto,
  WhatsAppRuleDto,
  WhatsAppRuleInput,
  WhatsAppStatusDto,
  WhatsAppTemplateDto,
  WhatsAppTemplateInput,
} from "./types/whatsappApi.types";

export const whatsappApi = {
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
};
