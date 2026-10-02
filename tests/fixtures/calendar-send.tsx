import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { message } from 'antd';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { authSession } from '../../src/api/authSession';
import { broadcastsApi } from '../../src/api/broadcastsApi';
import DayColumn from '../../src/pages/calendar/components/DayColumn';
import DayContextMenu from '../../src/pages/calendar/components/DayContextMenu';
import { formatDateForApi } from '../../src/pages/calendar/utils/dateUtils';
import { runCalendarSend } from '../../src/pages/configuration/components/broadcasts/calendarSendModel';
import { useCalendarSendSupport } from '../../src/pages/configuration/components/broadcasts/calendarSendSupport';
import { CalendarSendSettings } from '../../src/pages/configuration/components/broadcasts/CalendarSendSettings';
import { useCalendarSendTooltip } from '../../src/pages/configuration/components/broadcasts/calendarSendTarget';
import '../../src/pages/calendar/styles/calendar.css';
import '../../src/pages/calendar/styles/calendar-mobile.css';

// Fixture only: a day column + the same menu wiring as CalendarBoard, and the settings block.
// The browser script answers every API call with page.route mocks.
const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'day';
const compact = params.get('compact') === '1';

authSession.setUser({
  id: '11', username: 'E2E-Тест', role: 'admin',
  permissions: ['whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials'],
} as never);

function DayHarness() {
  const { support, minIntervalMinutes } = useCalendarSendSupport();
  const available = support === 'supported';
  const { title, refresh } = useCalendarSendTooltip(available);
  const [menu, setMenu] = useState({ visible: false, x: 0, y: 0, date: '' });
  const [sending, setSending] = useState<string[]>([]);
  const send = (date: string) => {
    if (sending.includes(date)) return;
    setSending((list) => [...list, date]);
    void runCalendarSend({ date, actorId: '11', send: broadcastsApi.calendarSend, minIntervalMinutes })
      .then((toast) => { if (toast) message[toast.type](toast.text); })
      .finally(() => setSending((list) => list.filter((d) => d !== date)));
  };
  return <DndProvider backend={HTML5Backend}>
    <output data-testid="support">{support}</output>
    {[new Date(2026, 9, 2), new Date(2026, 9, 3)].map((date) => <DayColumn
      key={date.toISOString()} date={date} orders={[]} columnWidth={320}
      onDaySend={available ? (d) => send(formatDateForApi(d)) : undefined}
      daySending={sending.includes(formatDateForApi(date))}
      daySendTitle={title} onDaySendHover={refresh}
      onDayContextMenu={available ? (e, d) => {
        e.preventDefault();
        refresh();
        setMenu({ visible: true, x: compact ? 8 : e.clientX, y: e.clientY, date: formatDateForApi(d) });
      } : undefined} />)}
    {menu.date && <DayContextMenu date={menu.date} visible={menu.visible} x={menu.x} y={menu.y} compact={compact} sendLabel={title}
      onClose={() => setMenu((m) => ({ ...m, visible: false }))}
      onSendToChat={send} />}
  </DndProvider>;
}

function SettingsHarness() {
  return <div style={{ padding: 24, width: 1100 }}><CalendarSendSettings captionVariables={[{ name: 'target_date', label: 'Дата заказов', example: '02.10.2026' }]} paused={false} /></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode>{mode === 'settings' ? <SettingsHarness /> : <DayHarness />}</React.StrictMode>);
