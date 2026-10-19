import { describe, expect, it } from 'vitest';
import type { OnecAlertGroupView, OnecAlertNotificationsOverview, OnecAlertPolicy } from '../../onec/onecAlertNotificationsApi';
import {
  buildPolicyUpdate,
  channelLabels,
  formProblem,
  overviewWarnings,
  policyToFormValues,
  quietHoursOptions,
  recipientsSummary,
  repeatLabel,
  whatsappStateLabel,
} from './onecAlertNotificationsModel';

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
  it('saves the form as is and does not send an unchanged chat', () => {
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

  it('turns the WhatsApp checkboxes into channels, keeps Telegram, and sends the chat only when it changed', () => {
    const chat = '120363000000000001@g.us';
    const withChat: OnecAlertPolicy = { ...policy, externalChannels: ['telegram', 'whatsapp_chat'], whatsappChatId: chat, whatsappChatName: 'Цех' };
    const values = policyToFormValues(withChat);
    expect(values).toMatchObject({ whatsappPersonal: false, whatsappChat: true, whatsappChatId: chat });
    const kept = buildPolicyUpdate(withChat, { ...values, whatsappPersonal: true, delayMinutes: 10, quietHours: null });
    expect(kept).toMatchObject({ externalChannels: ['telegram', 'whatsapp', 'whatsapp_chat'], delayMinutes: 10, quietHours: null });
    expect('whatsappChatId' in kept).toBe(false);
    const other = buildPolicyUpdate(withChat, { ...values, whatsappChatId: '120363000000000002@g.us', whatsappChatName: 'Офис' });
    expect(other).toMatchObject({ whatsappChatId: '120363000000000002@g.us', whatsappChatName: 'Офис' });
    const cleared = buildPolicyUpdate(withChat, { ...values, whatsappChat: false, whatsappChatId: null });
    expect(cleared).toMatchObject({ externalChannels: ['telegram'], whatsappChatId: null, whatsappChatName: null });
    expect(formProblem({ ...values, whatsappChatId: null })).toContain('Выберите чат');
    expect(formProblem(values)).toBeNull();
  });

  it('labels channels, quiet hours and WhatsApp states', () => {
    expect(channelLabels(policy)).toEqual(['Колокольчик', 'Окно с крестиком']);
    expect(channelLabels({ ...policy, externalChannels: ['whatsapp', 'whatsapp_chat'], whatsappChatName: 'Цех' })).toEqual([
      'Колокольчик',
      'Окно с крестиком',
      'WhatsApp лично',
      'WhatsApp-чат «Цех»',
    ]);
    const options = quietHoursOptions('01:00-05:00');
    expect(options[0]).toEqual({ value: 'none', label: 'Нет — отправлять в любое время' });
    expect(options[1]).toEqual({ value: '01:00-05:00', label: 'С 01:00 до 05:00' });
    expect(quietHoursOptions('23:00-08:00').filter((option) => option.value === '23:00-08:00')).toHaveLength(1);
    expect(whatsappStateLabel('skipped', 'NO_WORK_PHONE')).toBe('не отправлено: нет рабочего телефона');
    expect(whatsappStateLabel('cancelled', 'delivery_gap')).toBe('отменено: сервер перезапускался');
    expect(whatsappStateLabel(null, null)).toBe('в очереди');
  });

  it('warns about recipients WhatsApp cannot reach personally', () => {
    const messages = overviewWarnings(overview({ groups: [group({ withoutWorkPhone: [{ id: 3, name: 'sidorov' }] })] })).map((warning) => warning.message);
    expect(messages).toEqual(['«Агент не на связи»: в WhatsApp лично не получат sidorov — у сотрудника нет рабочего телефона.']);
  });
});
