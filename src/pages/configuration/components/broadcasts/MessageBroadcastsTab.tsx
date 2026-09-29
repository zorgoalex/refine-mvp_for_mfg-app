import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Spin } from 'antd';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import { ApiError } from '../../../../api/apiError';
import type { BroadcastsListResponse } from '../../../../api/broadcastsApiTypes';
import { DailyOrderDigestConfig } from '../DailyOrderDigestConfig';
import { BroadcastsPanel } from './BroadcastsPanel';
import { broadcastErrorMessage } from './broadcastModel';

type DetectionState =
  | { kind: 'loading' }
  | { kind: 'legacy' }
  | { kind: 'ready'; initial: BroadcastsListResponse }
  | { kind: 'error'; message: string };

/**
 * Feature detection for the «Рассылка сообщений» tab: a backend without the
 * broadcasts routes answers 404 to `GET /whatsapp/broadcasts`, in which case the
 * single-digest UI is rendered unchanged. The two UIs never mix: the legacy
 * component is not mounted (so calls no legacy routes) against the new backend.
 */
export const MessageBroadcastsTab: React.FC = () => {
  const [state, setState] = useState<DetectionState>({ kind: 'loading' });
  const requestRef = useRef(0);

  const detect = useCallback(async () => {
    const requestId = ++requestRef.current;
    setState({ kind: 'loading' });
    try {
      const initial = await broadcastsApi.list();
      if (requestId === requestRef.current) setState({ kind: 'ready', initial });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      if (error instanceof ApiError && error.status === 404) setState({ kind: 'legacy' });
      else setState({ kind: 'error', message: broadcastErrorMessage(error, 'Не удалось загрузить рассылки.') });
    }
  }, []);

  useEffect(() => {
    void detect();
    return () => { requestRef.current += 1; };
  }, [detect]);

  if (state.kind === 'loading') return <div style={{ padding: 24, textAlign: 'center' }}><Spin /></div>;
  if (state.kind === 'legacy') return <DailyOrderDigestConfig />;
  if (state.kind === 'error') {
    return <Alert type="error" showIcon message={state.message} action={<Button onClick={() => void detect()}>Повторить</Button>} />;
  }
  return <BroadcastsPanel initial={state.initial} />;
};
