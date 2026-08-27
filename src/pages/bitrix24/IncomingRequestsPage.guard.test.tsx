import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const page = readFileSync(new URL('./IncomingRequestsPage.tsx', import.meta.url), 'utf8');
const api = readFileSync(new URL('../../api/bitrix24Api.ts', import.meta.url), 'utf8');
const orderCreate = readFileSync(new URL('../orders/create.tsx', import.meta.url), 'utf8');
const orderForm = readFileSync(
  new URL('../orders/components/OrderForm.tsx', import.meta.url),
  'utf8',
);

describe('Bitrix24 incoming requests UI wiring', () => {
  it('keeps CRM amount separate from ERP detail calculation', () => {
    expect(page).toMatch(/Сумма CRM/);
    expect(page).toMatch(/Расчёт ERP/);
    expect(page).toMatch(/Сумма CRM хранится отдельно/);
    expect(api).not.toMatch(/crmAmount.*erpFinalAmount|erpFinalAmount.*crmAmount/);
  });

  it('uses backend commands for detail replacement, archive, conversion, payments, and retry', () => {
    expect(page).toMatch(/bitrix24Api\.replaceIncomingRequestDetails/);
    expect(page).toMatch(/bitrix24Api\.archiveIncomingRequest/);
    expect(page).toMatch(/bitrix24Api\.convertToProduction/);
    expect(page).toMatch(/bitrix24Api\.materializePayments/);
    expect(page).toMatch(/bitrix24Api\.retryFailed/);
    expect(page).toMatch(/bitrix24Api\.updatePaymentTypeMapping/);
    expect(page).toMatch(/bitrix24Api\.updateUserMapping/);
    expect(page).toMatch(/Ответственные пользователи/);
    expect(page).not.toMatch(/gql`|mutation\s/);
    expect(api).toMatch(/httpClient\.post/);
    expect(api).toMatch(/httpClient\.put/);
  });

  it('guards financial and integration actions with narrow permissions', () => {
    expect(page).toMatch(/can\('bitrix24\.requests\.update'/);
    expect(page).toMatch(/can\('bitrix24\.requests\.convert'/);
    expect(page).toMatch(/can\('bitrix24\.payments\.materialize'/);
    expect(page).toMatch(/can\('bitrix24\.integration\.manage'/);
    expect(page).toMatch(/can\('orders\.view_financials'/);
    expect(page).toMatch(/canViewFinancials\s*&&\s*can\('bitrix24\.payments\.materialize'/);
  });

  it('does not create or link a second ERP order from a Bitrix request', () => {
    expect(orderCreate).not.toMatch(/bitrix|Bitrix/);
    expect(orderForm).not.toMatch(/bitrixRequestDraft|Bitrix24OrderDraft/);
    expect(api).not.toMatch(/linkOrder/);
    expect(page).not.toMatch(/bitrixRequestId/);
  });
});
