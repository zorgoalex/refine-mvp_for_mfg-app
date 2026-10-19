import { describe, expect, it } from 'vitest';
import type { OnecAlertGroupView, OnecAlertNotificationsOverview, OnecAlertPolicy } from '../../onec/onecAlertNotificationsApi';
import { buildPolicyUpdate, overviewWarnings, policyToFormValues, recipientsSummary, repeatLabel } from './onecAlertNotificationsModel';

const policy: OnecAlertPolicy = {
  groupCode: 'agent_offline',
  importance: 'critical',
  recipientRoleCodes: ['admin'],
  recipientUserIds: [5],
  externalChannels: [],
  whatsappChatId: null,
  whatsappChatName: null,
  delayMinutes: 0,
  repeatMinutes: 120,
  notifyResolved: true,
  quietHours: '23:00-08:00',
  criticalIgnoresQuietHours: true,
  version: 3,
  updatedBy: null,
  updatedByName: null,
  updatedAt: '2026-10-19T00:00:00.000Z',
};

const group = (patch: Partial<OnecAlertGroupView> = {}): OnecAlertGroupView => ({
  code: 'agent_offline',
  label: 'Агент не на связи',
  windowSeconds: 0,
  kinds: [{ kind: 'agent_silent', label: 'Агент молчит' }],
  policy,
  recipients: { fallbackLevel: 2, users: [{ id: 1, name: 'Иванов' }] },
  filteredOut: [],
  ...patch,
});

const overview = (patch: Partial<OnecAlertNotificationsOverview> = {}): OnecAlertNotificationsOverview => ({
  flagEnabled: true,
  monitorOwner: 'in_process',
  active: true,
  enabledAt: null,
  lastTickAt: null,
  lastTickError: null,
  mandatoryChannels: ['in_app', 'balloon'],
  externalChannelsAvailable: [],
  groups: [group()],
  recipientOptions: { roles: [], users: [] },
  ...patch,
});

describe('onecAlertNotificationsModel', () => {
  it('keeps the fields that are not on the form when saving', () => {
    const values = { ...policyToFormValues(policy), recipientUserIds: [7, 5, 7], repeatMinutes: null };
    expect(buildPolicyUpdate(policy, values)).toEqual({
      importance: 'critical',
      recipientRoleCodes: ['admin'],
      recipientUserIds: [5, 7],
      externalChannels: [],
      delayMinutes: 0,
      repeatMinutes: null,
      notifyResolved: true,
      quietHours: '23:00-08:00',
      criticalIgnoresQuietHours: true,
    });
  });

  it('describes recipients with the fallback level and «nobody»', () => {
    expect(recipientsSummary(group())).toBe('Иванов (запасные: все с правом «Управление интеграцией 1С»)');
    expect(recipientsSummary(group({ recipients: null }))).toBe('Некому доставить');
    expect(repeatLabel(120)).toBe('Каждые 2 часа');
    expect(repeatLabel(null)).toBe('Не повторять');
  });

  it('warns about the switched-off flag, a missing monitor, nobody to deliver to and filtered users', () => {
    expect(overviewWarnings(overview())).toEqual([]);
    expect(overviewWarnings(overview({ flagEnabled: false }))[0].message).toContain('выключена на сервере');
    expect(overviewWarnings(overview({ monitorOwner: 'none' }))[0].type).toBe('error');
    const messages = overviewWarnings(
      overview({ groups: [group({ recipients: null, filteredOut: [{ userId: 9, username: 'petrov' }] })] }),
    ).map((warning) => warning.message);
    expect(messages).toEqual([
      'Неисправность: оповещения 1С некому доставить (Агент не на связи).',
      '«Агент не на связи»: не получат petrov — нет права «Просмотр интеграции 1С» или учётная запись отключена.',
    ]);
  });
});
