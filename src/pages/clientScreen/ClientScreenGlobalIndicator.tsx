import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Popconfirm } from 'antd';
import { EyeFilled, PoweroffOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';
import { ClientScreenMirror } from './ClientScreenMirror';
import { getClientScreenPresenter, useClientScreenView } from './clientScreenInstance';
import { clientScreenOrderPath } from './clientScreenOrderKeys';
import type { ClientScreenPresenter } from './clientScreenPresenter';
import { buildMirrorView } from './mirrorView';
import './clientScreen.css';
import './clientScreenPreview.css';

/**
 * Next to the notification bell, only while an order is presented to the customer: an eye that
 * shows a small live copy of the customer's screen (what was actually sent there), and the emergency
 * switch-off of the customer screen for the whole workstation. With no presentation nothing is drawn.
 */
const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 250;

/** The customer's screen in miniature: the last snapshot and interface state sent. */
const Preview: React.FC<{ presenter: ClientScreenPresenter }> = ({ presenter }) => {
  const preview = useSyncExternalStore(presenter.subscribePreview, presenter.getPreview);
  const view = useMemo(() => (preview ? buildMirrorView(preview.snapshot, preview.ui) : null), [preview]);
  const pageRef = useRef<HTMLDivElement | null>(null);

  // The same scroll position the customer window takes, inside the miniature only.
  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const ratio = preview?.ui?.scroll?.ratio ?? 0;
    page.scrollTop = Math.max(0, page.scrollHeight - page.clientHeight) * ratio;
  }, [preview, view]);

  return (
    <div className="client-screen-preview" aria-hidden="true">
      {view ? (
        <div className="client-screen-preview__page" ref={pageRef}>
          <div className="client-screen"><ClientScreenMirror view={view} frameTop={preview?.ui?.scroll?.frameTop ?? 0} /></div>
        </div>
      ) : (
        <div className="client-screen-preview__empty">У клиента сейчас заставка</div>
      )}
    </div>
  );
};

const Connected: React.FC<{ presenter: ClientScreenPresenter }> = ({ presenter }) => {
  const view = useClientScreenView();
  const navigate = useNavigate();
  const location = useLocation();
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<number | null>(null);
  const presentedOrderKey = view.presentedOrderKey;

  const schedule = (next: boolean) => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHovered(next), next ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
  };
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  // Presented from this window, or from another window of the browser (then there is nothing to preview here).
  const elsewhere = presentedOrderKey === null && view.presentingElsewhere && !view.workstationDisabled;
  const shown = presentedOrderKey !== null || elsewhere;
  useEffect(() => {
    if (!shown) {
      setPinned(false);
      setHovered(false);
    }
  }, [shown]);

  if (!shown) return null;
  const waiting = presentedOrderKey !== null && (view.phase !== 'owner' || view.policyStale);
  const orderPath = presentedOrderKey !== null ? clientScreenOrderPath(presentedOrderKey) : null;
  const open = hovered || pinned;

  return (
    <span
      className="client-screen-indicator"
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
    >
      <Button
        type="text"
        aria-label="Что видит клиент"
        aria-expanded={open}
        icon={<EyeFilled className={`client-screen-indicator__eye${waiting || elsewhere ? ' client-screen-indicator__eye--waiting' : ''}`} />}
        onClick={() => setPinned((value) => !value)}
      />
      <Popconfirm
        placement="bottomRight"
        title={(
          <div style={{ maxWidth: 320 }}>
            <div>Отключить экран клиента на этом рабочем месте?</div>
            <div style={{ fontWeight: 400 }}>Показ прекратится во всех вкладках. Клиенту можно показать свой экран: Win+P → «Повторяющийся».</div>
          </div>
        )}
        okText="Отключить"
        cancelText="Отмена"
        onConfirm={() => void presenter.disableWorkstation().catch(() => undefined)}
      >
        <Button type="text" danger icon={<PoweroffOutlined />} aria-label="Отключить экран клиента" title="Аварийно отключить экран клиента" />
      </Popconfirm>
      {open ? (
        <div className="client-screen-indicator__panel" role="dialog" aria-label="Экран клиента">
          {orderPath === null ? (
            <>
              <div className="client-screen-indicator__caption"><span>Клиенту показан заказ из другой вкладки браузера</span></div>
              <div className="client-screen-indicator__note">Миниатюра и «Скрыть от клиента» доступны в той вкладке. Аварийное отключение работает отсюда.</div>
            </>
          ) : (
            <>
              <div className="client-screen-indicator__caption">
                <span>{waiting ? 'Открываем экран клиента…' : 'Сейчас на экране клиента'}</span>
              </div>
              <Preview presenter={presenter} />
              <div className="client-screen-indicator__note">Уменьшенная копия того, что отправлено на экран клиента.</div>
              <div className="client-screen-indicator__actions">
                {location.pathname !== orderPath ? (
                  <Button size="small" onClick={() => { setPinned(false); navigate(orderPath); }}>Перейти к заказу</Button>
                ) : null}
                <Button size="small" onClick={() => presenter.hide()}>Скрыть от клиента</Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </span>
  );
};

/** An error here must not take the app header down: the indicator simply disappears. */
class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(): void {
    void getClientScreenPresenter()?.disableWorkstation().catch(() => undefined);
  }

  render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export const ClientScreenGlobalIndicator: React.FC = () => {
  const presenter = getClientScreenPresenter();
  if (!presenter) return null;
  return <Boundary><Connected presenter={presenter} /></Boundary>;
};

/** Marks the workspace tab whose order the customer sees right now. */
export const ClientScreenTabEye: React.FC<{ tabKey: string }> = ({ tabKey }) => {
  const { presentedOrderKey } = useClientScreenView();
  if (presentedOrderKey === null || clientScreenOrderPath(presentedOrderKey) !== tabKey) return null;
  return <EyeFilled className="client-screen-tab-eye" aria-label="Этот заказ показан клиенту" title="Этот заказ показан клиенту" />;
};
