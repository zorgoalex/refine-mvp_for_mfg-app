import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sheetSource = readFileSync('src/pages/orders/mobile/WorkbenchQuickPaymentSheet.tsx', 'utf8');
const showSource = readFileSync('src/pages/orders/show.tsx', 'utf8');
const appSource = readFileSync('src/App.tsx', 'utf8');

const mobileCss = readFileSync('src/ui-evolution/styles/workbench-mobile.css', 'utf8');

describe('workbench quick payment sheet wiring', () => {
  it('puts the sheet class on the Drawer root so the height limit reaches the content wrapper', () => {
    expect(sheetSource).toContain('rootClassName="wb-paysheet"');
    expect(sheetSource).not.toMatch(/\sclassName="wb-paysheet"/);
    expect(mobileCss).toMatch(/\.wb-paysheet \.ant-drawer-content-wrapper \{[^}]*max-height: 92dvh;/);
    expect(mobileCss).toMatch(/\.wb-paysheet \.ant-drawer-body \{[^}]*overflow-y: auto;/);
  });

  it('writes through the payments resource only (dataProvider → POST /payments)', () => {
    expect(sheetSource).toContain("resource: 'payments'");
    expect(sheetSource).toContain('runQuickPaymentAttempt(orderId, () => dataProvider().create({');
    expect(sheetSource).toContain('}), invalidateLists);');
    expect(sheetSource).not.toMatch(/graphql|hasura|insert_payments/i);
  });

  it('is offered only with backend payments, on a NewLine phone, for a live order with the create right', () => {
    expect(showSource).toContain(
      'const quickPaymentMounted = isWorkbench && featureFlags.useBackendPayments && !deletedOrder;',
    );
    expect(showSource).toContain('const quickPaymentAvailable = quickPaymentMounted && isMobile;');
    expect(showSource).toMatch(/const openAddPaymentForm = record\?\.order_id && canCreatePayment/);
    expect(showSource).toContain('const openAddPayment = openAddPaymentForm && quickPaymentAvailable');
  });

  it('refreshes the list resource that /orders really uses', () => {
    expect(appSource).toMatch(/name: ["']orders_view["'][\s\S]{0,200}list: ["']\/orders["']/);
    expect(sheetSource).toContain("invalidate({ resource: 'orders_view', invalidates: ['list'] })");
  });

  it('re-reads the order after every attempt (success, rejection, lost response) before another create', () => {
    // outcome comes from the attempt store (survives unmount), not from per-call callbacks
    expect(sheetSource).toContain("if (phase === 'submitting' && attempt?.status === 'settled') dispatch({ type: 'settled', outcome: attempt.outcome });");
    expect(sheetSource).toContain('useReducer(quickPaymentReducer, attempt, quickPaymentStateFromAttempt)');
    expect(sheetSource).toContain('if (ok) markQuickPaymentReconciled(orderId);');
    expect(sheetSource).not.toContain('useCreate');
    expect(sheetSource).toContain('canSubmitQuickPayment({');
    expect(showSource).toContain('onReconcile={reconcileQuickPayment}');
  });

  it('stays mounted across a phone/tablet breakpoint change: only visibility depends on the device tier', () => {
    expect(showSource).toContain('{quickPaymentMounted && openAddPaymentForm && record?.order_id ? (');
    expect(showSource).toContain('open={quickPaymentOpen && quickPaymentAvailable}');
  });

  it('re-reads the separate payments list too when order reads are not from the backend', () => {
    expect(showSource).toContain('const paymentsListActive = !!record?.order_id && !useBackendOrdersRead && canViewFinancials;');
    expect(showSource).toContain('refetchFresh((options) => queryResult.refetch(options))');
    expect(showSource).toContain('paymentsListActive ? refetchFresh((options) => refetchPaymentsList(options)) : Promise.resolve(true)');
    expect(showSource).toContain('return orderOk && paymentsOk;');
  });
});
