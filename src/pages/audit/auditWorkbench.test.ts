import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { auditActorInitials, auditChangeChips, auditPeriodRange, auditWhen } from './auditWorkbench';

const now = dayjs('2026-10-19T15:30:00');

describe('audit journal (NewLine)', () => {
  it('builds whole-day periods ending today', () => {
    expect(auditPeriodRange('all', now)).toBeNull();
    const today = auditPeriodRange('today', now)!;
    expect(today[0].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-10-19 00:00:00');
    expect(today[1].format('YYYY-MM-DD HH:mm:ss')).toBe('2026-10-19 23:59:59');
    expect(auditPeriodRange('7d', now)![0].format('YYYY-MM-DD')).toBe('2026-10-13');
    expect(auditPeriodRange('30d', now)![0].format('YYYY-MM-DD')).toBe('2026-09-20');
  });

  it('labels the day relative to today', () => {
    expect(auditWhen('2026-10-19T10:42:05', now)).toEqual({ time: '10:42:05', day: 'сегодня' });
    expect(auditWhen('2026-10-18T23:59:00', now).day).toBe('вчера');
    expect(auditWhen('2026-10-01T08:00:00', now).day).toBe('01.10.2026');
    expect(auditWhen(null, now)).toEqual({ time: '—', day: '' });
    expect(auditWhen('не дата', now)).toEqual({ time: 'не дата', day: '' });
  });

  it('takes initials from a name or a login', () => {
    expect(auditActorInitials('Тест Иванов')).toBe('ТИ');
    expect(auditActorInitials('codex_playwright')).toBe('CP');
    expect(auditActorInitials('admin')).toBe('AD');
    expect(auditActorInitials(null)).toBe('');
  });

  it('shows the first changes and counts the rest', () => {
    const changes = [
      { label: 'Сумма', before: '100', after: 'удалена' },
      { label: 'Оплачено', before: '100', after: '0' },
      { label: 'Статус', before: 'Частично', after: 'Не оплачен' },
    ];
    expect(auditChangeChips(changes)).toEqual({ chips: ['Сумма: 100 → удалена', 'Оплачено: 100 → 0'], more: 1 });
    expect(auditChangeChips([])).toEqual({ chips: [], more: 0 });
  });
});

describe('auditSourceLabel', () => {
  it('names the sources in words', async () => {
    const { auditSourceLabel } = await import('./auditWorkbench');
    expect(auditSourceLabel('backend-status-automation')).toBe('Автостатус');
    expect(auditSourceLabel('backend-orders-command')).toBe('Интерфейс');
    expect(auditSourceLabel('backend.bazis-cut')).toBe('Интерфейс');
    expect(auditSourceLabel('onec_loader')).toBe('1С');
    expect(auditSourceLabel('erp_1c_agent')).toBe('1С');
    expect(auditSourceLabel('bitrix24')).toBe('Bitrix24');
    expect(auditSourceLabel('crm-sync')).toBe('Bitrix24');
    expect(auditSourceLabel('erp_whatsapp_broadcast')).toBe('WhatsApp');
    expect(auditSourceLabel('waha_webhook')).toBe('WhatsApp');
    expect(auditSourceLabel('backend-cnc-telegram-command')).toBe('Telegram');
    expect(auditSourceLabel('backend-mdf-job')).toBe('МДФ-движок');
    expect(auditSourceLabel('dbeaver-bulk-sql')).toBe('Обслуживание');
    expect(auditSourceLabel('detail_status_trigger')).toBe('Этапы деталей');
    expect(auditSourceLabel('something_new')).toBe('something_new');
    expect(auditSourceLabel('')).toBeNull();
  });
});
