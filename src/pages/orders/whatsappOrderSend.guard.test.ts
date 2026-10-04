import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const show = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');

describe('order card WhatsApp send wiring', () => {
  it('builds the items once with the shared builder and gates them like export', () => {
    expect(show).toContain('buildOrderWhatsAppMenuItems(orderSendMenu');
    expect(show).toMatch(/useOrderSendMenu\(canExportOrders && \(!featureFlags\.useBackendPermissions \|\| can\('orders\.view'\)\), orderSendRefresh\)/);
    // A chosen phone is sent with the token of the number the menu showed, and nothing is sent when the choice is gone.
    expect(show).toMatch(/const target = withPhoneToken\(parsed\.target, orderSendMenu, orderClientContacts\);\s*if \(!target\) \{[^}]*return; \}/);
    expect(show).toMatch(/orderWhatsAppItems = canExportOrders && !deletedOrder/);
  });

  it('offers the sends through their own icon left of every «⋯» menu, never inside it', () => {
    // One dropdown with the items; the «⋯» menus (production overflow, header, mobile) carry none.
    expect(show.match(/\.\.\.orderWhatsAppItems/g)).toBeNull();
    expect(show.match(/isOrderWhatsAppKey\(key\)/g)?.length).toBe(1);
    const action = show.slice(show.indexOf('const orderSendAction'), show.indexOf('const productionPdfDisabled'));
    expect(action).toContain('items: orderWhatsAppItems');
    expect(action).toContain('aria-label="Отправить заказ"');
    expect(action).toContain('<SendOutlined />');
    // Nothing to send (sending off, no recipients): the icon stays, grey, with the hint — only for a user who may send.
    expect(action).toMatch(/orderSendAction = !canExportOrders \|\| deletedOrder \? null : orderWhatsAppItems\.length > 0 \?/);
    expect(action).toMatch(/<Tooltip title=\{ORDER_SEND_NOT_CONFIGURED_TITLE\}>\s*<Button aria-label="Отправить заказ" icon=\{<SendOutlined \/>\} disabled \/>/);
    // Rendered in all three heads (main has no «NewLine» head), each time right before the «⋯» dropdown of that head.
    expect(show.match(/\{orderSendAction\}/g)?.length).toBe(3);
    for (const more of show.split('aria-label="Ещё действия"').slice(0, -1)) {
      const head = more.slice(more.lastIndexOf('{orderSendAction}'));
      expect(head.match(/<Dropdown/g)?.length).toBe(1);
    }
  });

  it('sends through the idempotent runner and shows its toast', () => {
    expect(show).toContain('runOrderSend({');
    expect(show).toContain('message[result.type](result.text)');
  });
});
