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
/** `whatsapp` — each recipient personally, `whatsapp_chat` — the policy's WhatsApp chat; Telegram comes later. */
export type OnecAlertExternalChannel = 'telegram' | 'whatsapp' | 'whatsapp_chat';
export type OnecAlertExternalState = 'none' | 'pending_delay' | 'queued' | 'suppressed' | 'cancelled';
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
  /** Recipients WhatsApp cannot reach personally (no employee or work phone); only when the personal channel is on. */
  withoutWorkPhone?: { id: number; name: string }[];
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
  /** Absent — the chat is unchanged (changing it needs whatsapp.manage). */
  whatsappChatId?: string | null;
  whatsappChatName?: string | null;
  delayMinutes: number;
  repeatMinutes: number | null;
  notifyResolved: boolean;
  quietHours: string | null;
  criticalIgnoresQuietHours: boolean;
}

/** One WhatsApp recipient row of a dispatch, latest attempt first. */
export interface OnecAlertExternalRecipient {
  recipientRowId: number;
  channel: 'whatsapp';
  userId: number | null;
  username?: string | null;
  chatId: string | null;
  attempt: number;
  status: 'queued' | 'skipped' | 'superseded';
  state: string | null;
  reason: string | null;
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
  externalState?: OnecAlertExternalState;
  external?: OnecAlertExternalRecipient[];
}

export interface OnecAlertTestResult {
  notificationId: string;
  channels: string[];
  visibleInBell: boolean;
  whatsapp?: { target: 'self' | 'chat'; state: string; reason: string | null }[];
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

  test(group: OnecAlertGroupCode): Promise<OnecAlertTestResult> {
    return httpClient.post(path(`/alert-notification-policies/${groupPath(group)}/test`), {});
  },

  recent(limit = 30): Promise<{ data: OnecAlertRecentDispatch[] }> {
    return httpClient.get(path(`/alert-notifications/recent?limit=${Math.min(Math.max(Math.trunc(limit), 1), 200)}`));
  },
};
