import React from 'react';
import ReactDOM from 'react-dom/client';
import { ClientScreenOff, ClientScreenPage } from './ClientScreenPage';

/**
 * Mounts the customer window instead of the main app: no Refine, no auth provider, no router, no
 * API client. The window shows only what a manager window sends it.
 */
export function mountClientScreen(container: HTMLElement, options: { enabled: boolean }): void {
  // The window is all customer screen: no page margin around it.
  document.body.style.margin = '0';
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      {options.enabled ? <ClientScreenPage /> : <ClientScreenOff />}
    </React.StrictMode>,
  );
}
