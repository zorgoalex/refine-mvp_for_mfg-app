import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Dropdown, Modal, message } from 'antd';
import { EllipsisOutlined, WhatsAppOutlined } from '@ant-design/icons';
import { authSession } from '../../src/api/authSession';
import { orderSendApi } from '../../src/api/orderSendApi';
import { OrderSendSettings } from '../../src/pages/configuration/components/broadcasts/OrderSendSettings';
import {
  buildOrderWhatsAppMenuItems,
  describeOrderWhatsAppSend,
  isOrderWhatsAppKey,
  parseOrderWhatsAppKey,
} from '../../src/pages/orders/whatsappOrderSendMenu';
import { runOrderSend } from '../../src/pages/orders/whatsappOrderSendModel';
import { useOrderSendMenu } from '../../src/pages/orders/whatsappOrderSendSupport';

// Fixture only: the same wiring as the order card (hook + builder + runner) around an antd Dropdown, and the settings block.
// The browser script answers every API call with page.route mocks.
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'menu';
const hasPhone = params.get('phone') !== '0';

authSession.setUser({
  id: '11', username: 'E2E-Тест', role: 'admin',
  permissions: ['whatsapp.manage', 'orders.view', 'orders.export'],
} as never);

function MenuHarness() {
  const menu = useOrderSendMenu(true);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set<string>());
  const items = buildOrderWhatsAppMenuItems(menu, { hasClientPhone: hasPhone, sending: busy, icon: <WhatsAppOutlined /> });
  // Same wiring as show.tsx, including the confirmation after an unknown outcome.
  const send = (key: string, confirmAfterUnknown?: string) => {
    const parsed = parseOrderWhatsAppKey(key);
    if (!parsed || !menu || busy.has(key)) return;
    const { targetLabel, formTitle } = describeOrderWhatsAppSend(menu, parsed.target, parsed.form);
    setBusy((keys) => new Set(keys).add(key));
    void runOrderSend({ orderId: 77, target: parsed.target, form: parsed.form, actorId: '11', targetLabel, formTitle, send: orderSendApi.send, confirmAfterUnknown })
      .then((result) => {
        if (!result) return;
        if (result.confirmUnknown) {
          const previous = result.confirmUnknown;
          Modal.confirm({ title: 'Результат прежней отправки неизвестен', content: result.text, okText: 'Отправить ещё раз', cancelText: 'Не отправлять',
            onOk: () => send(key, previous.sendId) });
          return;
        }
        message[result.type](result.text);
      })
      .finally(() => setBusy((keys) => { const next = new Set(keys); next.delete(key); return next; }));
  };
  return <div style={{ padding: 24 }}>
    <output data-testid="items">{items.length}</output>
    {items.length > 0 ? <Dropdown trigger={['click']} menu={{ items: items as never, onClick: ({ key }) => { if (isOrderWhatsAppKey(key)) send(key); } }}>
      <Button aria-label="Ещё действия" icon={<EllipsisOutlined />} />
    </Dropdown> : null}
  </div>;
}

function SettingsHarness() {
  return <div style={{ padding: 24, width: 1100 }}><OrderSendSettings /></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{mode === 'settings' ? <SettingsHarness /> : <MenuHarness />}</React.StrictMode>);
