import React from 'react';
import { createRoot } from 'react-dom/client';
import { MessageBroadcastsTab } from '../../src/pages/configuration/components/broadcasts/MessageBroadcastsTab';

// Fixture only: the whole «Рассылка сообщений» tab; the browser script answers every API call with mocks.
createRoot(document.getElementById('root')!).render(<React.StrictMode><div style={{ padding: 24, width: 1200 }}><MessageBroadcastsTab /></div></React.StrictMode>);
