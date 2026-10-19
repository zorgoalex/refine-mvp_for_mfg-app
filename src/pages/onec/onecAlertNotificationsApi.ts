import { backendApiPath } from '../../api/apiRoutes';
import { httpClient } from '../../api/httpClient';

/** Delivery of 1C alerts (plan 2026-10-19 §3–4): «Конфигурация → Оповещения 1С». */
export type OnecAlertGroupCode =
  | 'agent_offline'
  | 'agent_state'
  | 'sync'
  | 'commands'
  | 'config_source'
  | 'certificate'
  | 'stock_snapshots'
  | 'other';
export type OnecAlertPolicyImportance = 'auto' | 'critical' | 'important' | 'info';
export type OnecAlertImportance = Exclude<OnecAlertPolicyImportance, 'auto'>;
export type OnecAlertExternalChannel = 'telegram' | 'whatsapp';
export type OnecAlertStage = 'opened' | 'escalated' | 'reminder' | 'resolved' | 'digest';

export interface OnecAlertPolicy {
  groupCode: OnecAlertGroupCode;
  importance: OnecAlertPolicyImportance;
  recipientRoleCodes: string[];
  recipientUserIds: number[];
  externalChannels: OnecAlertExternalChannel[];
  whatsappChatId: string | null;
  whatsappChatName: string | null;
  delayMinutes: number;
  repeatMinutes: number | null;
  notifyResolved: boolean;
  quietHours: string | null;
  criticalIgnoresQuietHours: boolean;
  version: number;
  updatedBy: number | null;
  updatedByName: string | null;
  updatedAt: string;
}

export interface OnecAlertGroupView {
  code: OnecAlertGroupCode;
  label: string;
  windowSeconds: number;
  kinds: { kind: string; label: string }[];
  policy: OnecAlertPolicy;
  /** Who would receive a stage now; null — nobody (a stage then waits and a critical alert is raised). */
  recipients: { fallbackLevel: 1 | 2 | 3; users: { id: number; name: string }[] } | null;
  filteredOut: { userId: number; username: string }[];
}

export interface OnecAlertNotificationsOverview {
  flagEnabled: boolean;
  monitorOwner: string;
  active: boolean;
  enabledAt: string | null;
  lastTickAt: string | null;
  lastTickError: string | null;
  mandatoryChannels: string[];
  externalChannelsAvailable: OnecAlertExternalChannel[];
  groups: OnecAlertGroupView[];
  recipientOptions: { roles: { code: string; name: string }[]; users: { id: number; name: string }[] };
}

export interface OnecAlertPolicyUpdate {
  importance: OnecAlertPolicyImportance;
  recipientRoleCodes: string[];
  recipientUserIds: number[];
  externalChannels: OnecAlertExternalChannel[];
  delayMinutes: number;
  repeatMinutes: number | null;
  notifyResolved: boolean;
  quietHours: string | null;
  criticalIgnoresQuietHours: boolean;
}

export interface OnecAlertRecentDispatch {
  dispatchId: number;
  groupCode: OnecAlertGroupCode;
  groupLabel: string;
  stage: OnecAlertStage;
  importance: OnecAlertImportance;
  sourceId: number | null;
  fallbackLevel: number;
  createdAt: string;
  members: number;
  kinds: string[];
  kindLabels: string[];
  recipients: { userId: number; username: string | null; shown: boolean; read: boolean }[];
}

const GROUP_PATTERN = /^[a-z_]{1,32}$/;

function groupPath(group: string): string {
  if (!GROUP_PATTERN.test(group)) throw new Error('Invalid 1C alert group');
  return group;
}

const path = (suffix: string) => backendApiPath(`/onec${suffix}`);

export const onecAlertNotificationsApi = {
  overview(): Promise<OnecAlertNotificationsOverview> {
    return httpClient.get(path('/alert-notification-policies'));
  },

  update(group: OnecAlertGroupCode, version: number, body: OnecAlertPolicyUpdate): Promise<{ policy: OnecAlertPolicy }> {
    return httpClient.patch(path(`/alert-notification-policies/${groupPath(group)}`), body, { headers: { 'If-Match': String(version) } });
  },

  test(group: OnecAlertGroupCode): Promise<{ notificationId: string; channels: string[]; visibleInBell: boolean }> {
    return httpClient.post(path(`/alert-notification-policies/${groupPath(group)}/test`), {});
  },

  recent(limit = 30): Promise<{ data: OnecAlertRecentDispatch[] }> {
    return httpClient.get(path(`/alert-notifications/recent?limit=${Math.min(Math.max(Math.trunc(limit), 1), 200)}`));
  },
};
