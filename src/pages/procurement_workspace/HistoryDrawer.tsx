import { Alert, Button, Drawer, Empty, Space, Timeline, Typography } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { procurementWorkspaceApi } from '../../api/procurementWorkspaceApi';
import type { ProcurementHistoryEvent, ProcurementHistoryResponse } from '../../api/types/procurementHistoryApi.types';
import { OrderNumber } from '../order_resource_requirements/OrderNumber';
import { currentSummaryLines, historyDocumentLabel, historyEventTitle, historyRequestLinkLabels, sortHistoryEventsDesc } from './historyHelpers';
import { RrScreen } from './RrScreen';

export interface HistoryDrawerLine {
  orderId: number;
  resourceKey: string;
  /** Имя материала строки рабочего списка — пока история не загрузилась, или если сервер его не знает. */
  name: string;
  orderName: string;
  fullNumber: string;
}

export interface HistoryDrawerProps {
  /** null — Drawer закрыт. Отдельный экземпляр на строку (см. `key` у вызывающего) — ответ по закрытой
   *  строке не подменит открытую. */
  line: HistoryDrawerLine | null;
  onClose: () => void;
}

type HistoryState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ProcurementHistoryResponse; loadingMore: boolean };

/** «История» материала заказа в рабочем списке снабжения (этап 4a): текущее состояние + лента событий. */
export function HistoryDrawer({ line, onClose }: HistoryDrawerProps) {
  const [state, setState] = useState<HistoryState>({ status: 'idle' });
  const sequence = useRef(0);
  // Ответ, пришедший после закрытия Drawer или смены строки, не применяется.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const load = useCallback(async (target: HistoryDrawerLine, before: string | undefined, append: boolean) => {
    const id = ++sequence.current;
    if (append) {
      setState((current) => (current.status === 'ready' ? { ...current, loadingMore: true } : current));
    } else {
      setState({ status: 'loading' });
    }
    try {
      const response = await procurementWorkspaceApi.history({ orderId: target.orderId, resourceKey: target.resourceKey, before });
      if (!aliveRef.current || id !== sequence.current) return;
      setState((current) => {
        if (append && current.status === 'ready') {
          return { status: 'ready', data: { ...response, events: [...current.data.events, ...response.events] }, loadingMore: false };
        }
        return { status: 'ready', data: response, loadingMore: false };
      });
    } catch (error) {
      if (!aliveRef.current || id !== sequence.current) return;
      setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить историю' });
    }
  }, []);

  const key = line ? `${line.orderId}|${line.resourceKey}` : null;
  useEffect(() => {
    if (!line) { setState({ status: 'idle' }); return; }
    void load(line, undefined, false);
    // key отражает orderId+resourceKey целиком — line пересоздаётся при каждом открытии.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const loadMore = () => {
    if (!line || state.status !== 'ready' || !state.data.nextCursor) return;
    void load(line, state.data.nextCursor, true);
  };

  const materialName = state.status === 'ready' ? state.data.current?.name ?? line?.name : line?.name;
  const events = state.status === 'ready' ? sortHistoryEventsDesc(state.data.events) : [];
  const currentLines = state.status === 'ready' ? currentSummaryLines(state.data.current) : [];
  const hasWarning = state.status === 'ready' && Boolean(state.data.current?.changedSinceMark);

  return (
    <Drawer
      open={line !== null}
      onClose={onClose}
      width={560}
      destroyOnClose
      title={line ? (
        <Space direction="vertical" size={0}>
          <b>{materialName}</b>
          <OrderNumber orderName={line.orderName} fullNumber={line.fullNumber} />
        </Space>
      ) : 'История'}
    >
      {line && (
        // Drawer рендерится в портал вне экрана — стили rr-* и токены темы подключаются своей обёрткой.
        <RrScreen>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {state.status === 'loading' && <Typography.Text type="secondary">Загрузка…</Typography.Text>}
            {state.status === 'error' && <Alert type="error" showIcon message={state.message} />}
            {state.status === 'ready' && (
              <>
                {currentLines.length > 0 && (
                  <Alert
                    type={hasWarning ? 'warning' : 'info'}
                    showIcon
                    message={
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {currentLines.map((text, index) => <span key={index}>{text}</span>)}
                      </div>
                    }
                  />
                )}
                {events.length === 0 ? (
                  <Empty description="Событий пока нет" />
                ) : (
                  // antd 5.0.5: у Timeline нет `items` (появился в 5.2) — только Timeline.Item.
                  <Timeline>
                    {events.map((event) => (
                      <Timeline.Item key={event.id}>
                        <HistoryEventRow event={event} />
                      </Timeline.Item>
                    ))}
                  </Timeline>
                )}
                {state.data.nextCursor && (
                  <Button loading={state.loadingMore} onClick={loadMore} style={{ alignSelf: 'flex-start' }}>
                    Показать ещё
                  </Button>
                )}
              </>
            )}
          </div>
        </RrScreen>
      )}
    </Drawer>
  );
}

function HistoryEventRow({ event }: { event: ProcurementHistoryEvent }) {
  const documentLabel = historyDocumentLabel(event.document);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span>{historyEventTitle(event)}</span>
      {historyRequestLinkLabels(event).map((text, index) => <span key={index} className="rr-sub">{text}</span>)}
      <span className="rr-sub">
        {dayjs(event.at).format('DD.MM.YYYY HH:mm')}
        {event.actorName ? ` · ${event.actorName}` : ''}
      </span>
      {documentLabel && (
        <span className="rr-sub">
          {event.document ? (
            <Link to={`/procurement/onec-documents/show/${event.document.documentId}`}>{documentLabel}</Link>
          ) : documentLabel}
        </span>
      )}
    </div>
  );
}
