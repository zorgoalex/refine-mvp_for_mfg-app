import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order card WhatsApp send wiring', () => {
  it('builds the items once with the shared builder and gates them like export', () => {
    expect(show).toContain('buildOrderWhatsAppMenuItems(orderSendMenu');
    expect(show).toMatch(/useOrderSendMenu\(canExportOrders && \(!featureFlags\.useBackendPermissions \|\| can\('orders\.view'\)\)\)/);
    expect(show).toMatch(/orderWhatsAppItems = canExportOrders && !deletedOrder/);
  });

  it('puts the items into all three «⋯» menus and handles their clicks', () => {
    // standard desktop + mobile + operational head + workbench = 4 spreads
    expect(show.match(/\.\.\.orderWhatsAppItems/g)?.length).toBe(4);
    expect(show.match(/isOrderWhatsAppKey\(key\)/g)?.length).toBe(4);
    const operational = show.slice(show.indexOf('const productionExcelOverflowAction'), show.indexOf('const productionExcelOverflowAction') + 900);
    expect(operational).toContain('...orderWhatsAppItems');
    const workbench = show.slice(show.indexOf('const workbenchMoreItems'), show.indexOf('const workbenchMoreItems') + 600);
    expect(workbench).toContain('...orderWhatsAppItems');
  });

  it('sends through the idempotent runner and shows its toast', () => {
    expect(show).toContain('runOrderSend({');
    expect(show).toContain('message[toast.type](toast.text)');
  });
});
