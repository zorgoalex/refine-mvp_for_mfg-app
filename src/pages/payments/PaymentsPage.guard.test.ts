import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text guards (Vitest runs in node, no DOM): the «Поступления 1С» tab is gated; its writes are the slice B commands.
const page = readFileSync(new URL('./PaymentsPage.tsx', import.meta.url), 'utf8');
const tab = readFileSync(new URL('./OnecReceiptsTab.tsx', import.meta.url), 'utf8');
const actions = readFileSync(new URL('./OnecReceiptActions.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../api/paymentsOnecApi.ts', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');

describe('«Платежи → Поступления 1С» guards', () => {
  it('shows the tab only with the 1C flag and both permissions; otherwise the screen is the plain payments list', () => {
    expect(page).toMatch(/featureFlags\.useBackendOnec && can\('payments\.onec\.view'\) && can\('payments\.view'\) && can\('orders\.view_financials'\)/);
    expect(page).toMatch(/if \(!canSeeOnecReceiptsTab\(\)\) return <PaymentList \{\.\.\.props\} \/>;/);
    expect(page).toContain('destroyInactiveTabPane');
  });

  it('is routed under the financial gate of /payments', () => {
    expect(app).toMatch(/<Route path="\/payments" element=\{<FinancialRoute><Outlet \/><\/FinancialRoute>\}>\s*<Route index element=\{<PaymentsPage \/>\} \/>/);
  });

  it('reads and writes only through the backend API; writes are the slice B commands, offered only with capabilities.commands', () => {
    expect(api).toContain('apiRoutes.paymentsOnec.receipts');
    // The only writes: the five commands of the tab, each to its own backend route (no Hasura, no generic dataProvider).
    expect(api.match(/httpClient\.(post|put|patch|delete)/g)).toHaveLength(6);
    for (const route of ['receiptMatch', 'receiptUnmatch', 'receiptDismiss', 'receiptOrderLink', 'receiptOrderUnlink']) {
      expect(api).toContain(`apiRoutes.paymentsOnec.${route}(lineId)`);
    }
    expect(api).toContain('apiRoutes.paymentsOnec.autoMatch');
    expect(tab).toMatch(/response\?\.capabilities\.commands && \(\s*<Button onClick=\{runAutoMatch\}/);
    for (const source of [tab, actions]) expect(source).not.toMatch(/useList|useMany|dataProvider|httpClient/);
    expect(tab).toContain('paymentsOnecApi.listReceipts');
    expect(tab).toContain('paymentsOnecApi.getReceipt');
    // Buttons follow the backend capability and the line state (pure helper), never a local guess.
    expect(actions).toContain('onecReceiptActions(line, card.capabilities.commands)');
    expect(actions).toMatch(/const toolbar = card\.capabilities\.commands \?/);
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
