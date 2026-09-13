import React from 'react';
import { createRoot } from 'react-dom/client';
import { TelegramWorkerAudit } from '../../src/pages/audit/TelegramWorkerAudit';

createRoot(document.getElementById('root')!).render(<TelegramWorkerAudit />);
