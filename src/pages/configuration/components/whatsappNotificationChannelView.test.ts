import { describe, expect, it } from 'vitest';
import type { WhatsAppNotificationChannelDto } from '../../../api/types/whatsappApi.types';
import {
  WHATSAPP_NOTIFICATION_STATE_VIEW,
  whatsappNotificationChannelHealth,
  whatsappNotificationReason,
  whatsappNotificationSource,
  whatsappNotificationUserLabel,
} from './whatsappNotificationChannelView';

const channel = (patch: Partial<WhatsAppNotificationChannelDto> = {}): WhatsAppNotificationChannelDto => ({
  enabled: true, relayOwner: 'in_process', deliverable: true, paused: false, epoch: 3, epochStartedAt: null,
  queued: 0, lastSentAt: null, last24h: {}, limits: { globalGapSeconds: 10, perRecipientHourly: 20, purgeAfterDays: 30 }, ...patch,
});

describe('WhatsApp notification channel view', () => {
  it('names every state of the channel', () => {
    expect(Object.keys(WHATSAPP_NOTIFICATION_STATE_VIEW).sort())
      .toEqual(['cancelled', 'failed', 'queued', 'sending', 'sent', 'skipped', 'unknown']);
  });

  it('explains the channel state: off, another sender, paused, working', () => {
    expect(whatsappNotificationChannelHealth(channel({ enabled: false, deliverable: false })).title).toBe('WhatsApp выключен');
    expect(whatsappNotificationChannelHealth(channel({ relayOwner: 'none', deliverable: false })).title).toBe('Этот сервер не отправляет уведомления');
    expect(whatsappNotificationChannelHealth(channel({ paused: true })).tone).toBe('warning');
    expect(whatsappNotificationChannelHealth(channel()).tone).toBe('success');
  });

  it('shows known reasons in words and unknown codes as they are', () => {
    expect(whatsappNotificationReason('delivery_gap')).toBe('Поставлено до перезапуска сервера и не отправлялось');
    expect(whatsappNotificationReason('NO_WORK_PHONE')).toBe('У сотрудника нет основного рабочего телефона');
    expect(whatsappNotificationReason('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(whatsappNotificationReason(null)).toBeNull();
    expect(whatsappNotificationSource('onec_alert')).toBe('Оповещения 1С');
    expect(whatsappNotificationSource('other_module')).toBe('other_module');
  });

  it('labels a user recipient by what is known', () => {
    const user = { kind: 'user' as const, userId: 21, username: 'ivanov', employeeName: 'Иванов Иван', phoneMasked: '+7 701 *** ** 60' };
    expect(whatsappNotificationUserLabel(user)).toBe('Иванов Иван (ivanov)');
    expect(whatsappNotificationUserLabel({ ...user, employeeName: null })).toBe('ivanov');
    expect(whatsappNotificationUserLabel({ ...user, employeeName: null, username: null })).toBe('Пользователь #21');
  });
});
