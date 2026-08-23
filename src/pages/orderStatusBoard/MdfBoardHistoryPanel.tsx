import {
  Alert,
  Button,
  Empty,
  Select,
  Skeleton,
  Tag,
  Typography,
} from 'antd';
import {
  BranchesOutlined,
  ClockCircleOutlined,
  CloseOutlined,
  DownOutlined,
  HistoryOutlined,
  SearchOutlined,
  UpOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import type {
  MdfBoardHistoryColumn,
  MdfBoardHistoryEpisode,
  MdfBoardHistoryEvent,
  MdfBoardHistoryOrderOption,
  MdfBoardHistoryResponse,
  MdfBoardHistorySubjectKind,
} from '../../api/types/cncTelegramApi.types';

interface MdfBoardHistoryPanelProps {
  boardDate: string;
  collapsed: boolean;
  selectedOrderId: number | null;
  selectedOrderNumber: string | null;
  onCollapsedChange: (collapsed: boolean) => void;
  onClose: () => void;
  onFocusCard: (kind: MdfBoardHistorySubjectKind, cardId: string) => void;
  onSelectedOrderChange: (orderId: number | null, orderNumber: string | null) => void;
}

export const MdfBoardHistoryPanel: React.FC<MdfBoardHistoryPanelProps> = ({
  boardDate,
  collapsed,
  selectedOrderId,
  selectedOrderNumber,
  onCollapsedChange,
  onClose,
  onFocusCard,
  onSelectedOrderChange,
}) => {
  const [search, setSearch] = useState('');
  const [options, setOptions] = useState<MdfBoardHistoryOrderOption[]>([]);
  const [history, setHistory] = useState<MdfBoardHistoryResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchRevision = useRef(0);
  const historyRevision = useRef(0);

  useEffect(() => {
    const revision = ++searchRevision.current;
    const timer = window.setTimeout(() => {
      setSearching(true);
      void cncTelegramApi.searchMdfBoardHistoryOrders(search, 20, { cache: 'no-store' })
        .then((response) => {
          if (searchRevision.current === revision) setOptions(response.data);
        })
        .catch(() => {
          if (searchRevision.current === revision) setOptions([]);
        })
        .finally(() => {
          if (searchRevision.current === revision) setSearching(false);
        });
    }, search ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (selectedOrderId === null) {
      ++historyRevision.current;
      setHistory(null);
      setLoading(false);
      setError(null);
      return;
    }
    const revision = ++historyRevision.current;
    setLoading(true);
    setError(null);
    void cncTelegramApi.mdfBoardHistory(selectedOrderId, boardDate, { cache: 'no-store' })
      .then((response) => {
        if (historyRevision.current === revision) setHistory(response);
      })
      .catch((requestError: unknown) => {
        if (historyRevision.current !== revision) return;
        setHistory(null);
        setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить историю');
      })
      .finally(() => {
        if (historyRevision.current === revision) setLoading(false);
      });
  }, [boardDate, selectedOrderId]);

  const selectOptions = useMemo(() => {
    const source = selectedOrderId !== null
      && selectedOrderNumber
      && !options.some((order) => order.orderId === selectedOrderId)
      ? [{
          orderId: selectedOrderId,
          orderName: selectedOrderNumber,
          fullNumber: selectedOrderNumber,
          deleted: false,
          createdAt: '',
        }, ...options]
      : options;
    return source.map((order) => ({
      value: order.orderId,
      label: (
        <span className="mdf-history-search-option">
          <span>{order.orderName}</span>
          {order.deleted && <Tag color="default">Удалён</Tag>}
        </span>
      ),
    }));
  }, [options, selectedOrderId, selectedOrderNumber]);

  return (
    <section
      className={`mdf-history${collapsed ? ' mdf-history--collapsed' : ''}`}
      aria-labelledby="mdf-history-title"
    >
      <header className="mdf-history__header">
        <div>
          <Typography.Title id="mdf-history-title" level={4} className="mdf-history__title">
            <HistoryOutlined /> История МДФ-доски
          </Typography.Title>
          <Typography.Text type="secondary">
            Найдите заказ и посмотрите, что привело его в текущую колонку.
          </Typography.Text>
        </div>
        <div className="mdf-history__header-actions">
          {!collapsed && (
            <Tag icon={<ClockCircleOutlined />} className="mdf-history__period">
              С создания заказа
            </Tag>
          )}
          <Button
            type="text"
            className="mdf-history__header-button"
            icon={collapsed ? <DownOutlined /> : <UpOutlined />}
            aria-label={collapsed ? 'Развернуть историю' : 'Свернуть историю'}
            aria-expanded={!collapsed}
            onClick={() => onCollapsedChange(!collapsed)}
          />
          <Button
            type="text"
            className="mdf-history__header-button"
            icon={<CloseOutlined />}
            aria-label="Закрыть историю"
            onClick={onClose}
          />
        </div>
      </header>

      {!collapsed && (
        <div className="mdf-history__body">
          <Select
            className="mdf-history__search"
            size="large"
            showSearch
            allowClear
            filterOption={false}
            value={selectedOrderId ?? undefined}
            options={selectOptions}
            loading={searching}
            placeholder="Номер заказа"
            suffixIcon={<SearchOutlined />}
            notFoundContent={searching ? 'Поиск…' : 'Заказы не найдены'}
            onSearch={setSearch}
            onClear={() => onSelectedOrderChange(null, null)}
            onChange={(value: number | undefined) => {
              const order = options.find((candidate) => candidate.orderId === value);
              onSelectedOrderChange(
                value ?? null,
                value === undefined ? null : order?.orderName ?? selectedOrderNumber ?? String(value),
              );
            }}
            aria-label="Поиск заказа в истории МДФ-доски"
          />

          {loading && <HistorySkeleton />}
          {!loading && error && (
            <Alert type="error" showIcon message="История недоступна" description={error} />
          )}
          {!loading && !error && !history && (
            <Empty
              className="mdf-history__empty"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="Выберите заказ — здесь появится его путь и причина текущего положения"
            />
          )}
          {!loading && !error && history && (
            <HistoryContent history={history} onFocusCard={onFocusCard} />
          )}
        </div>
      )}
    </section>
  );
};

const HistoryContent: React.FC<{
  history: MdfBoardHistoryResponse;
  onFocusCard: MdfBoardHistoryPanelProps['onFocusCard'];
}> = ({ history, onFocusCard }) => {
  const diagnosis = history.diagnosis;
  return (
    <div className="mdf-history__content">
      <section
        className={`mdf-history-diagnosis mdf-history-diagnosis--${diagnosis.presence}`}
        aria-labelledby="mdf-history-diagnosis-title"
      >
        <div className="mdf-history-diagnosis__heading">
          <div>
            <Typography.Text className="mdf-history-diagnosis__eyebrow">
              Почему сейчас здесь
            </Typography.Text>
            <Typography.Title id="mdf-history-diagnosis-title" level={5}>
              {diagnosis.title}
            </Typography.Title>
          </div>
          <Tag color={diagnosis.presence === 'on_board' ? 'blue' : diagnosis.presence === 'deleted' ? 'red' : 'gold'}>
            {diagnosis.presence === 'on_board' ? 'На доске' : diagnosis.presence === 'deleted' ? 'Удалён' : 'Нет на доске'}
          </Tag>
        </div>
        <Typography.Paragraph className="mdf-history-diagnosis__explanation">
          {diagnosis.explanation}
        </Typography.Paragraph>
        {diagnosis.blockers.length > 0 && (
          <ul className="mdf-history-blockers">
            {diagnosis.blockers.map((blocker) => (
              <li key={blocker.code}>{blocker.text}</li>
            ))}
          </ul>
        )}
        {diagnosis.manualOverride && (
          <Alert
            type="info"
            showIcon
            message={`Ручное положение: ${columnTitle(diagnosis.manualOverride.targetColumn)}`}
            description={`${diagnosis.manualOverride.actorName ?? 'Пользователь'} · ${formatDateTime(diagnosis.manualOverride.updatedAt)}`}
          />
        )}
        {diagnosis.relatedCurrentCards.length > 0 && (
          <div className="mdf-history-current-cards" aria-label="Связанные карточки на текущей доске">
            {diagnosis.relatedCurrentCards.map((card) => (
              <Button
                key={`${card.subjectKind}:${card.subjectId}`}
                size="small"
                disabled={!card.existsNow || !card.cardId}
                onClick={() => card.cardId && onFocusCard(card.subjectKind, card.cardId)}
              >
                {card.label} · {columnTitle(card.currentColumn)}
              </Button>
            ))}
          </div>
        )}
      </section>

      <div className="mdf-history__coverage">
        <Tag color={history.coverage.status === 'recorded_exact' ? 'green' : history.coverage.status === 'none' ? 'default' : 'gold'}>
          {history.coverage.label}
        </Tag>
        <Typography.Text type="secondary">
          {history.window.dateFrom} — {history.window.dateTo}
        </Typography.Text>
      </div>

      {history.episodes.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="В выбранном периоде движений не найдено" />
      ) : (
        <ol className="mdf-history-timeline" aria-label="Путь заказа по МДФ-доске">
          {history.episodes.map((episode) => (
            <HistoryEpisodeRow key={episode.episodeId} episode={episode} onFocusCard={onFocusCard} />
          ))}
        </ol>
      )}
    </div>
  );
};

const HistoryEpisodeRow: React.FC<{
  episode: MdfBoardHistoryEpisode;
  onFocusCard: MdfBoardHistoryPanelProps['onFocusCard'];
}> = ({ episode, onFocusCard }) => (
  <li className="mdf-history-timeline__item">
    <span className="mdf-history-timeline__dot" aria-hidden="true" />
    <article className="mdf-history-event">
      <div className="mdf-history-event__meta">
        <time dateTime={episode.occurredAt}>{formatDateTime(episode.occurredAt)}</time>
        <span>{episode.primaryEvent.actor.displayName}</span>
        {episode.primaryEvent.provenance !== 'recorded' && <Tag>Восстановлено</Tag>}
      </div>
      <EventBody event={episode.primaryEvent} onFocusCard={onFocusCard} />
      {episode.relatedEvents.length > 0 && (
        <details className="mdf-history-event__related">
          <summary><BranchesOutlined /> Связанные изменения: {episode.relatedEvents.length}</summary>
          <div className="mdf-history-event__related-list">
            {episode.relatedEvents.map((event) => (
              <EventBody key={event.eventId} event={event} onFocusCard={onFocusCard} compact />
            ))}
          </div>
        </details>
      )}
    </article>
  </li>
);

const EventBody: React.FC<{
  event: MdfBoardHistoryEvent;
  compact?: boolean;
  onFocusCard: MdfBoardHistoryPanelProps['onFocusCard'];
}> = ({ event, compact = false, onFocusCard }) => {
  const currentCard = event.relatedCurrentCards.find((card) => card.existsNow && card.cardId);
  return (
    <div className={compact ? 'mdf-history-event__body mdf-history-event__body--compact' : 'mdf-history-event__body'}>
      <div className="mdf-history-event__title-row">
        <Typography.Text strong>{event.subjectLabel}</Typography.Text>
        {(event.fromColumn || event.toColumn) && (
          <span className="mdf-history-event__transition">
            {event.fromColumn ? columnTitle(event.fromColumn) : 'Появление'}
            <span aria-hidden="true"> → </span>
            {event.toColumn ? columnTitle(event.toColumn) : 'Вне доски'}
          </span>
        )}
      </div>
      <Typography.Paragraph>{event.reason}</Typography.Paragraph>
      <Typography.Text type="secondary">Следствие: {event.consequence}</Typography.Text>
      {currentCard?.cardId && (
        <Button
          type="link"
          size="small"
          onClick={() => onFocusCard(currentCard.subjectKind, currentCard.cardId!)}
        >
          Показать карточку на доске
        </Button>
      )}
    </div>
  );
};

const HistorySkeleton: React.FC = () => (
  <div className="mdf-history__skeleton" aria-label="Загрузка истории">
    <Skeleton active paragraph={{ rows: 2 }} />
    <Skeleton active paragraph={{ rows: 4 }} />
  </div>
);

function formatDateTime(value: string): string {
  return dayjs(value).format('DD.MM.YYYY HH:mm');
}

function columnTitle(column: MdfBoardHistoryColumn | null): string {
  if (!column) return 'нет колонки';
  return {
    parsed: 'Файлы на станке',
    completed: 'Распилено',
    completed_laminated: 'Распиленные файлы',
    baths: 'Карты ванн',
    baths_ready: 'Готовы к закатке',
    baths_laminated: 'Закатаны',
    completed_baths: 'Завершённые ванны',
    orders: 'Заказы',
    orders_ready: 'Готов к выдаче',
    orders_issued: 'Выдан',
  }[column];
}
