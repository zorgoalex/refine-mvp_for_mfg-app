import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text guards (Vitest runs in node, no DOM): the «Поступления 1С» tab is gated and read-only in slice A.
const page = readFileSync(new URL('./PaymentsPage.tsx', import.meta.url), 'utf8');
const tab = readFileSync(new URL('./OnecReceiptsTab.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../api/paymentsOnecApi.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('«Платежи → Поступления 1С» guards', () => {
  it('shows the tab only with the 1C flag and both permissions; otherwise the screen is the plain payments list', () => {
    expect(page).toMatch(/featureFlags\.useBackendOnec && can\('payments\.onec\.view'\) && can\('payments\.view'\)/);
    expect(page).toMatch(/if \(!canSeeOnecReceiptsTab\(\)\) return <PaymentList \{\.\.\.props\} \/>;/);
    expect(page).toContain('destroyInactiveTabPane');
  });

  it('is routed under the financial gate of /payments', () => {
    expect(app).toMatch(/<Route path="\/payments" element=\{<FinancialRoute><Outlet \/><\/FinancialRoute>\}>\s*<Route index element=\{<PaymentsPage \/>\} \/>/);
  });

  it('reads only through the backend API and has no write calls in slice A', () => {
    expect(api).toContain('apiRoutes.paymentsOnec.receipts');
    expect(api).not.toMatch(/httpClient\.(post|put|patch|delete)/);
    expect(tab).not.toMatch(/useList|useMany|dataProvider|httpClient/);
    expect(tab).toContain('paymentsOnecApi.listReceipts');
    expect(tab).toContain('paymentsOnecApi.getReceipt');
  });

  it('handles the disabled feature and a stale response', () => {
    expect(tab).toMatch(/isApiError\(error, 'ONEC_PAYMENT_MATCHING_DISABLED'\)/);
    expect(tab).toContain('Сверка поступлений 1С пока не включена');
    expect(tab).toMatch(/if \(current === generation\.current\) setState/);
    expect(tab).toMatch(/if \(current !== generation\.current\) return;/);
  });

  it('never prints payment attributes itself: they come only through the helper that honours «hidden»', () => {
    expect(tab).not.toMatch(/row\.payment\.(amount|paymentDate|typeName|orderName)/);
    expect(tab).toContain('onecReceiptPaymentText(row)');
    expect(tab).toMatch(/!entry\.payment \|\| !\('paymentId' in entry\.payment\)/);
  });
});
