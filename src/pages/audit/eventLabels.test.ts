import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_TITLES, auditEventOptions, auditEventTitle } from './eventLabels';

describe('journal event labels', () => {
  it('sorts by Russian titles, retains raw filter values and searches both languages', () => {
    const events = ['cut_job.deleted', 'auth.login.success', 'cut_job.created', 'cut_job.deleted'];
    const options = auditEventOptions(events);
    expect(options.map((option) => option.value)).toEqual(['auth.login.success', 'cut_job.created', 'cut_job.deleted']);
    expect(options[2].label).toBe('Удалено задание на раскрой — cut_job.deleted');
    expect(events).toHaveLength(4);
  });
  it('has Russian labels and deterministic ordering throughout the catalog', () => {
    const options = auditEventOptions(Object.keys(AUDIT_EVENT_TITLES).reverse());
    for (const option of options) expect(auditEventTitle(option.value)).toMatch(/[А-Яа-яЁё]/);
    for (let i = 1; i < options.length; i++) {
      expect(auditEventTitle(options[i - 1].value).localeCompare(auditEventTitle(options[i].value), 'ru')).toBeLessThanOrEqual(0);
    }
  });
  it('keeps unrecognized events available without inventing an action', () => {
    expect(auditEventOptions(['future.event'])[0]).toEqual({ value: 'future.event', label: 'Событие ERP: future.event — future.event' });
    expect(auditEventTitle('constructor')).toBe('Событие ERP: constructor');
  });
  it('labels payment and Bitrix payment events', () => {
    expect(auditEventTitle('payments.restore')).toBe('Восстановлен платёж');
    expect(auditEventTitle('crm_sync.payment_paid_reset_completed')).toBe('Bitrix: оплата обновлена');
    expect(auditEventTitle('crm_sync.payment_paid_reset_stuck')).toBe('Bitrix: не удалось обновить оплату');
    expect(auditEventTitle('crm_sync.payment_card_closed')).toBe('Bitrix: закрыта карточка «Поступила оплата»');
    expect(auditEventTitle('crm_sync.payment_card_close_failed')).toBe('Bitrix: не удалось закрыть карточку оплаты');
    expect(auditEventTitle('crm_sync.payment_card_close_requested')).toBe('Bitrix: запрошено закрытие карточки оплаты');
    expect(auditEventTitle('crm_sync.upsert', 'payment')).toBe('Оплата отправлена в Bitrix');
    expect(auditEventTitle('crm_sync.delete', 'payment')).toBe('Оплата удалена в Bitrix');
    expect(auditEventTitle('crm_sync.upsert', 'order')).toBe('Синхронизирована запись CRM');
    expect(auditEventTitle('crm_sync.upsert')).toBe('Синхронизирована запись CRM');
  });
});
