import React, { lazy, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MDF_BOARD_PREFETCH_EVENT } from '../../utils/siderMenuItems';
import {
  isMdfBoardSnapshotReady,
  MDF_BOARD_SNAPSHOT_READY_EVENT,
} from '../../utils/mdfBoardPrewarm';

const MdfWorkBoardPage = lazy(async () => ({
  default: (await import('../../pages/orderStatusBoard')).MdfWorkBoardPage,
}));

const MDF_ROUTE = '/mdf-work-board';

export const PersistentMdfBoardHost: React.FC = () => {
  const location = useLocation();
  const active = location.pathname === MDF_ROUTE;
  const [mounted, setMounted] = useState(active);
  const initiallyActiveRef = useRef(active);
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (active) setMounted(true);
  }, [active]);

  useEffect(() => {
    let idleId: number | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const mountWhenIdle = () => {
      if (mounted) return;
      const idleWindow = window as Window & {
        requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      };
      if (typeof idleWindow.requestIdleCallback === 'function') {
        idleId = idleWindow.requestIdleCallback(() => setMounted(true), { timeout: 30_000 });
      } else {
        timerId = globalThis.setTimeout(() => setMounted(true), 5_000);
      }
    };
    if (isMdfBoardSnapshotReady()) mountWhenIdle();
    window.addEventListener(MDF_BOARD_SNAPSHOT_READY_EVENT, mountWhenIdle);
    return () => {
      window.removeEventListener(MDF_BOARD_SNAPSHOT_READY_EVENT, mountWhenIdle);
      if (idleId !== null) window.cancelIdleCallback(idleId);
      if (timerId !== null) window.clearTimeout(timerId);
    };
  }, [mounted]);

  useEffect(() => {
    const revealBeforeNavigation = () => {
      if (hostRef.current && mounted) hostRef.current.hidden = false;
    };
    window.addEventListener(MDF_BOARD_PREFETCH_EVENT, revealBeforeNavigation);
    return () => window.removeEventListener(MDF_BOARD_PREFETCH_EVENT, revealBeforeNavigation);
  }, [mounted]);

  if (!mounted) return null;
  return (
    <div ref={hostRef} hidden={!active} data-persistent-mdf-board="true">
      <MdfWorkBoardPage active={initiallyActiveRef.current} />
    </div>
  );
};
