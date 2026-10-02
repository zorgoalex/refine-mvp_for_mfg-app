import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, notification } from 'antd';
import { authSession } from '../../src/api/authSession';
import { MyWhatsAppSendsBlock } from '../../src/components/whatsapp/MyWhatsAppSendsBlock';
import { announceWhatsAppSendQueued, currentOwner } from '../../src/components/whatsapp/myWhatsAppSendsModel';
import { useMyWhatsAppSends } from '../../src/components/whatsapp/useMyWhatsAppSends';

// Fixture only: the same hook and block the bell uses; the browser script answers /whatsapp/my-sends.
// The app-wide static notification limit is set like App.tsx (maxCount 3) to prove the balloons do not share it.
notification.config({ maxCount: 3 });
const setUser = (id: string) => authSession.setUser({ id, username: `E2E-Тест-${id}`, role: 'manager', permissions: ['orders.view', 'orders.export'] } as never);
setUser('11');

function Bell() {
  const { items, contextHolder } = useMyWhatsAppSends();
  return <>
    {contextHolder}
    <output data-testid="count">{items.length}</output>
    <MyWhatsAppSendsBlock items={items} />
  </>;
}

function Harness() {
  const [session, setSession] = useState('11');
  return <div style={{ padding: 24 }}>
    <Button onClick={() => void announceWhatsAppSendQueued(new URLSearchParams(window.location.search).get('queued') ?? '00000000-0000-4000-8000-00000000000a',
      { kind: 'order_send', orderId: 1 }, currentOwner())}>queued</Button>
    <Button onClick={() => notification.info({ message: 'Обычное уведомление приложения', placement: 'bottomRight', duration: 30 })}>app</Button>
    <Button onClick={() => { setUser('12'); setSession('12'); }}>switch user</Button>
    <Bell key={session} />
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><Harness /></React.StrictMode>);
