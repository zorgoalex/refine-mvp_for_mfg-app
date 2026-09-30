import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Broadcast, BroadcastCatchUpPolicy, BroadcastEnvelope } from '../../src/api/broadcastsApiTypes';
import { BroadcastEditor } from '../../src/pages/configuration/components/broadcasts/BroadcastEditor';

// Fixture only: the real broadcast editor; the browser script answers every API call with mocks.
const params = new URLSearchParams(window.location.search);
const policy = (params.get('policy') ?? 'skip') as BroadcastCatchUpPolicy;

const initial: Broadcast = {
  id: 1, version: 3, archived: false, scheduleGeneration: 1, createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z',
  updatedBy: null, name: 'Рассылка заказов', enabled: true, groupChatId: '120363338054016575@g.us', weekdays: [1, 2, 3, 4, 5, 6, 7],
  sendTime: '08:45', sendWindowMinutes: 30, catchUpPolicy: policy, catchUpDeadline: '10:00', partialPolicy: 'remaining',
  orderDateOffsetDays: 0, cardsPerMessage: 2, captionTemplate: 'Заказы на сегодня',
};

function App() {
  const [broadcast, setBroadcast] = useState<Broadcast>(initial);
  const [dirty, setDirty] = useState(false);
  const [saves, setSaves] = useState(0);
  return (
    <div style={{ padding: 24, width: 1100 }}>
      <BroadcastEditor
        broadcast={broadcast}
        todaySchedule={null}
        captionVariables={[{ name: 'target_date', label: 'Дата заказов', example: '30.09.2026' }]}
        actorId="11"
        onSaved={(envelope: BroadcastEnvelope) => { setBroadcast(envelope.broadcast); setSaves((n) => n + 1); }}
        onEnvelope={(envelope: BroadcastEnvelope) => setBroadcast(envelope.broadcast)}
        onArchived={() => undefined}
        onConflict={() => undefined}
        onDirtyChange={setDirty}
        onClose={() => undefined}
      />
      <div data-testid="dirty">{String(dirty)}</div>
      <div data-testid="saves">{saves}</div>
      <pre data-testid="saved-policy">{broadcast.catchUpPolicy} {broadcast.catchUpDeadline} v{broadcast.version}</pre>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
