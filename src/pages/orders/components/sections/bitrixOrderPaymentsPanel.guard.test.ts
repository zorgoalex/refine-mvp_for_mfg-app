import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panel = readFileSync(
  new URL('./BitrixOrderPaymentsPanel.tsx', import.meta.url),
  'utf8',
);
const requests = readFileSync(
  new URL('../../../bitrix24/IncomingRequestsPage.tsx', import.meta.url),
  'utf8',
);

describe('Bitrix payment convergence selection', () => {
  it('keeps ERP-linked snapshots selectable for explicit update/delete convergence', () => {
    expect(panel).toContain('payment.erpPaymentId === null');
    expect(panel).toContain('|| payment.erpPaymentId !== null');
    expect(requests).toContain('payment.erpPaymentId !== null');
  });

  it('requires a danger confirmation before mutating linked ERP payments', () => {
    expect(panel).toContain('Modal.confirm');
    expect(panel).toContain('okButtonProps: { danger: true }');
    expect(requests).toContain('Modal.confirm');
  });

  it('still gates materialization behind the materialize permission', () => {
    expect(panel).toContain("can('bitrix24.payments.materialize')");
    expect(requests).toContain("can('bitrix24.payments.materialize'");
  });

  it('never auto-selects or auto-submits linked snapshots', () => {
    expect(panel).not.toContain('setSelectedIds(view.payments');
    expect(requests).not.toContain('setSelectedPaymentIds(selected.payments');
  });
});
