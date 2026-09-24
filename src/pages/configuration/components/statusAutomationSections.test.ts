import { describe, expect, it } from 'vitest';
import { statusAutomationSection } from './statusAutomationSections';

describe('auto-status sections', () => {
  it.each([
    ['mdf.board.completed', 'mdf'], ['mdf.order_machine_files_present', 'mdf'],
    ['mdf.board.baths', 'mdf'], ['mdf.board.baths_ready', 'mdf'], ['mdf.board.baths_laminated', 'mdf'],
    ['payment.created', 'payments'], ['order.payment_status_changed', 'payments'],
    ['message.signal_detected', 'messages'], ['order.created', 'order'], ['order.updated', 'order'],
    ['order.planned_completion_date_changed', 'dates'], ['order.status_changed', 'statuses'],
    ['order.production_status_changed', 'statuses'], ['future.event', 'other'],
  ])('keeps %s visible in %s without a catalogue', (event, section) => {
    expect(statusAutomationSection(event)).toBe(section);
  });

  it('separates MDF from other production events', () => {
    expect(statusAutomationSection('mdf.board.completed', { group: 'production' })).toBe('mdf');
    expect(statusAutomationSection('machine.completed', { group: 'production' })).toBe('production');
  });

  it('uses catalogue metadata for new events', () => {
    expect(statusAutomationSection('invoice.paid', { group: 'payments' })).toBe('payments');
  });
});
