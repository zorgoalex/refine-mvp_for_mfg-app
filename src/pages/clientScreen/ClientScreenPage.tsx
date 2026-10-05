import React, { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ViewerState } from './clientScreenArbiter';
import { browserClientScreenEnvironment } from './clientScreenEnvironment';
import { startClientScreenViewer, type ClientScreenViewer } from './clientScreenViewerRuntime';
import { ClientScreenMirror } from './ClientScreenMirror';
import { buildMirrorView } from './mirrorView';
import './clientScreen.css';

/**
 * The customer window. It only draws what the manager window sends: no backend calls, no order
 * form, no drafts. Without messages it shows the splash.
 */
interface PageState {
  state: ViewerState | null;
  role: 'starting' | 'viewer' | 'duplicate' | 'unsupported';
}

function useViewer(): PageState {
  const viewerRef = useRef<ClientScreenViewer | null>(null);
  const supportedRef = useRef(true);
  const cache = useRef<PageState>({ state: null, role: 'starting' });
  const listeners = useRef(new Set<() => void>());

  useEffect(() => {
    let viewer: ClientScreenViewer;
    try {
      viewer = startClientScreenViewer(browserClientScreenEnvironment(), {
        close: () => {
          // A window opened by script can close itself; otherwise it stays on the "switched off" splash.
          window.close();
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
        },
      });
    } catch {
      supportedRef.current = false;
      listeners.current.forEach((listener) => listener());
      return undefined;
    }
    viewerRef.current = viewer;
    const unsubscribe = viewer.subscribe(() => listeners.current.forEach((listener) => listener()));
    listeners.current.forEach((listener) => listener());
    return () => {
      unsubscribe();
      viewer.stop();
      viewerRef.current = null;
    };
  }, []);

  return useSyncExternalStore(
    (listener) => {
      listeners.current.add(listener);
      return () => listeners.current.delete(listener);
    },
    () => {
      const viewer = viewerRef.current;
      const next: PageState = !supportedRef.current
        ? { state: null, role: 'unsupported' }
        : viewer ? { state: viewer.getState(), role: viewer.getRole() } : { state: null, role: 'starting' };
      if (next.state !== cache.current.state || next.role !== cache.current.role) cache.current = next;
      return cache.current;
    },
  );
}

const Splash: React.FC<{ text: string; hint?: string }> = ({ text, hint }) => (
  <div className="client-screen__splash">
    <div className="client-screen__brand">{text}</div>
    {hint ? <div className="client-screen__hint">{hint}</div> : null}
    {typeof document !== 'undefined' && !document.fullscreenElement ? (
      <button
        type="button"
        className="client-screen__fullscreen"
        onClick={() => void document.documentElement.requestFullscreen().catch(() => undefined)}
      >
        На весь экран
      </button>
    ) : null}
  </div>
);

export const ClientScreenPage: React.FC = () => {
  const { state, role } = useViewer();
  const shown = state?.shown ?? null;
  const ui = state?.ui ?? null;
  const view = useMemo(() => (shown ? buildMirrorView(shown.snapshot, ui) : null), [shown, ui]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.title = 'Экран клиента';
  }, []);

  // Follow the manager: first the scroll position, then the row or field being worked on.
  useLayoutEffect(() => {
    if (!view) return;
    const scroll = ui?.scroll;
    if (scroll) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo({ top: Math.max(0, max) * scroll.ratio });
      if (scroll.anchorRowId) {
        bodyRef.current?.querySelector(`[data-row-id="${scroll.anchorRowId}"]`)?.scrollIntoView({ block: 'nearest' });
      }
    }
    // The cell the manager is on first (it may be off-screen in a wide table), then the field, then the row.
    const body = bodyRef.current;
    const focused = body?.querySelector('[data-focused="true"]')
      ?? body?.querySelector('.client-screen__field--focused')
      ?? body?.querySelector('.client-screen__row--focused');
    focused?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [view, ui]);

  let content: React.ReactNode;
  if (role === 'unsupported') content = <Splash text="Экран клиента" hint="Этот браузер не подходит: нужен актуальный Chrome или Edge." />;
  else if (role === 'duplicate') content = <Splash text="Экран клиента" hint="Экран клиента уже открыт в другом окне. Это окно можно закрыть." />;
  else if (state?.screen === 'disabled') content = <Splash text="Экран клиента отключён" />;
  else if (!view) content = <Splash text="Экран клиента" hint="Здесь появится ваш заказ" />;
  else {
    content = <ClientScreenMirror view={view} bodyRef={bodyRef} />;
  }
  return <div className="client-screen">{content}</div>;
};

/** Shown instead of the page when the customer screen is switched off for the deployment: nothing runs. */
export const ClientScreenOff: React.FC = () => (
  <div className="client-screen">
    <div className="client-screen__splash">
      <div className="client-screen__brand">Экран клиента выключен</div>
    </div>
  </div>
);

export default ClientScreenPage;
