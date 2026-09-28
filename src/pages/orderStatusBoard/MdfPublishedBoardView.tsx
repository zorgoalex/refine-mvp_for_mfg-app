import { Badge, Dropdown, Empty, Select, Tag, Typography } from 'antd';
import { Tooltip } from '../../ui/tooltipDelay';
import { SearchOutlined, WarningOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import React, { useMemo, useState } from 'react';
import type {
  MdfSessionSnapshot,
  MdfSourceColumn,
  MdfSourceKind,
} from '../../api/types/mdfPublishedApi.types';
import {
  collectMdfCommentLinkCandidates,
  extractMdfCommentFileLinks,
} from './mdfBoardCommentLinks';
import {
  MDF_PUBLISHED_BOARD_COLUMNS,
  buildMdfPublishedBoardCards,
  buildMdfUnregisteredLane,
  filterMdfPublishedCardsByOrderNames,
  filterMdfPublishedCardsByText,
  groupMdfPublishedBoardCardsByColumn,
  type MdfPublishedBoardCard,
} from './mdfPublishedBoard';
import type { CncOrderSearchPeriod } from './model';

const MOVE_COLUMNS_BY_KIND: Record<MdfSourceKind, MdfSourceColumn[]> = {
  packet: ['parsed', 'completed', 'completed_laminated'],
  bazisCutSet: ['parsed', 'completed', 'completed_laminated'],
  bath: ['baths', 'baths_ready', 'baths_laminated', 'completed_baths'],
};
const COLUMN_TITLE_BY_KEY = new Map<string, string>(
  MDF_PUBLISHED_BOARD_COLUMNS.map((column) => [column.key, column.title]),
);

export interface MdfPublishedBoardViewProps {
  session: MdfSessionSnapshot;
  workday: string;
  period: CncOrderSearchPeriod | undefined;
  orderFilters: readonly string[];
  searchText: string;
  /** §5.6 finding 6: order ids currently in the active explicit search (from
   * `requestSearchOrderNames`) — their cards are exempt from the period filter. */
  searchOrderIds: readonly number[];
  focusKind: MdfSourceKind | null;
  focusId: string | null;
  searchResolving: boolean;
  /** §5.6 finding 9: literal `production.tasks.update` permission check, evaluated by the caller. */
  canMove: boolean;
  onRequestSearchOrderNames: (names: readonly string[]) => void;
  onMove: (card: MdfPublishedBoardCard, targetColumn: MdfSourceColumn, targetTitle: string) => void;
  onFocusCard: (kind: MdfSourceKind, id: string) => void;
}

export const MdfPublishedBoardView: React.FC<MdfPublishedBoardViewProps> = ({
  session,
  orderFilters,
  searchText,
  focusKind,
  focusId,
  searchResolving,
  canMove,
  onRequestSearchOrderNames,
  onMove,
  onFocusCard,
}) => {
  const { snapshot } = session;
  const readOnly = snapshot.mode === 'read_only';
  const cards = useMemo(() => buildMdfPublishedBoardCards(snapshot, canMove), [snapshot, canMove]);
  // §5.8: the period is applied ONCE, by the backend display cut (`displayFrom`, legacy per-kind dates: packet workday,
  // BASIS/bath creation), with search/focus bypass. Re-filtering here by creation date hid packets the backend admitted.
  const visible = useMemo(() => {
    let result = filterMdfPublishedCardsByOrderNames(cards, orderFilters);
    result = filterMdfPublishedCardsByText(result, searchText);
    return result;
  }, [cards, orderFilters, searchText]);
  const grouped = useMemo(() => groupMdfPublishedBoardCardsByColumn(visible), [visible]);
  const unregistered = useMemo(() => buildMdfUnregisteredLane(snapshot), [snapshot]);
  const commentCandidates = useMemo(() => collectMdfCommentLinkCandidates(snapshot.presentation), [snapshot.presentation]);
  const hasAnyCards = visible.length > 0 || unregistered.length > 0;

  return (
    <div className="mdf-published-board">
      {readOnly && (
        <Tag color="gold" className="mdf-published-board__mode-tag">
          Только чтение — перемещение отключено
        </Tag>
      )}
      {/* §5.6 finding 6: the search control must always render — including on an empty board —
       * so an old/out-of-window card can still be searched for. */}
      <div className="mdf-published-board__search">
        <MdfPublishedOrderSearch loading={searchResolving} onSearch={onRequestSearchOrderNames} />
      </div>
      {!hasAnyCards ? (
        <Empty description="По выбранным фильтрам МДФ-карточек нет" />
      ) : (
        <>
          <div className="mdf-published-board__columns">
            {MDF_PUBLISHED_BOARD_COLUMNS.map((column) => {
              const columnCards = grouped.get(column.key) ?? [];
              if (columnCards.length === 0) return null;
              return (
                <section key={column.key} className="mdf-published-board__column" aria-label={column.title}>
                  <header className="mdf-published-board__column-header">
                    <Typography.Text strong>{column.title}</Typography.Text>
                    <Badge count={columnCards.length} showZero color="default" />
                  </header>
                  <div className="mdf-published-board__column-cards">
                    {columnCards.map((card) => (
                      <MdfPublishedCardView
                        key={`${card.kind}:${card.id}`}
                        card={card}
                        focused={focusKind === card.kind && focusId === card.id}
                        commentCandidates={commentCandidates}
                        onMove={onMove}
                        onFocusCard={onFocusCard}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
            {grouped.get('unknown')?.length ? (
              <section className="mdf-published-board__column" aria-label="Без колонки">
                <header className="mdf-published-board__column-header">
                  <Typography.Text strong>Без колонки</Typography.Text>
                  <Badge count={grouped.get('unknown')!.length} showZero color="default" />
                </header>
                <div className="mdf-published-board__column-cards">
                  {grouped.get('unknown')!.map((card) => (
                    <MdfPublishedCardView
                      key={`${card.kind}:${card.id}`}
                      card={card}
                      focused={focusKind === card.kind && focusId === card.id}
                      commentCandidates={commentCandidates}
                      onMove={onMove}
                      onFocusCard={onFocusCard}
                    />
                  ))}
                </div>
              </section>
            ) : null}
          </div>
          {unregistered.length > 0 && (
            <section className="mdf-published-board__unregistered" aria-label="Ожидает учёта">
              <Typography.Title level={5}>Ожидает учёта</Typography.Title>
              <Typography.Text type="secondary">
                Найдены в производстве, но ещё не приняты производственным учётом. Только просмотр.
              </Typography.Text>
              <ul className="mdf-published-board__unregistered-list">
                {unregistered.map((source) => (
                  <li key={`${source.kind}:${source.id}`}>
                    <Typography.Text strong>{source.displayName}</Typography.Text>
                    {source.orderNames.length > 0 && (
                      <span className="mdf-published-board__unregistered-orders"> · {source.orderNames.join(', ')}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};

const MdfPublishedOrderSearch: React.FC<{ loading: boolean; onSearch: (names: readonly string[]) => void }> = ({
  loading,
  onSearch,
}) => {
  const [value, setValue] = useState<string[]>([]);
  return (
    <Select
      mode="tags"
      size="small"
      allowClear
      tokenSeparators={[',']}
      value={value}
      loading={loading}
      placeholder="Найти заказ вне периода (номер заказа)"
      suffixIcon={<SearchOutlined />}
      style={{ minWidth: 260 }}
      onChange={(next: string[]) => {
        setValue(next);
        // §5.6 R2#2: propagate the CURRENT selection unconditionally — including an empty one
        // (clearing/removing a tag) — so the caller can clear/shrink `searchOrderIds` accordingly.
        // Skipping the call on an empty selection left previously searched orders' cards exempt
        // from the period filter forever.
        onSearch(next);
      }}
      aria-label="Найти заказ вне загруженного периода МДФ-доски"
    />
  );
};

const MdfPublishedCardView: React.FC<{
  card: MdfPublishedBoardCard;
  focused: boolean;
  commentCandidates: ReturnType<typeof collectMdfCommentLinkCandidates>;
  onMove: MdfPublishedBoardViewProps['onMove'];
  onFocusCard: MdfPublishedBoardViewProps['onFocusCard'];
}> = ({ card, focused, commentCandidates, onMove, onFocusCard }) => {
  const targets = MOVE_COLUMNS_BY_KIND[card.kind].filter((key) => key !== card.column);
  const menuItems: MenuProps['items'] = targets.map((key) => ({
    key,
    label: COLUMN_TITLE_BY_KEY.get(key) ?? key,
  }));
  const moveDisabled = card.commandDisabledReason !== null;

  return (
    <article
      className={`mdf-published-card${card.stale ? ' mdf-published-card--stale' : ''}${focused ? ' mdf-published-card--focused' : ''}`}
      data-mdf-published-card={`${card.kind}:${card.id}`}
    >
      <header className="mdf-published-card__header">
        <Typography.Text strong className="mdf-published-card__title">{card.title}</Typography.Text>
        {card.requiresAttention && (
          <Tooltip title={card.issueTexts.join('; ')}>
            <Tag color="red" icon={<WarningOutlined />}>Требует проверки</Tag>
          </Tooltip>
        )}
        {card.pendingNote && <Tag color="processing">{card.pendingNote}</Tag>}
      </header>
      {card.orderNames.length > 0 && (
        <div className="mdf-published-card__orders">
          {card.orderNames.map((name) => (
            <Tag key={name}>{name}</Tag>
          ))}
        </div>
      )}
      {card.stale && (
        <Typography.Text type="warning" className="mdf-published-card__stale-note">
          {card.staleNote}
        </Typography.Text>
      )}
      {/* §5.6 finding 8: composition-derived rows (detail number, sizes) — richer, but only
       * available when the card is not stale and its composition carries items (some bath
       * presentations do not). */}
      {!card.stale && card.items.length > 0 && (
        <ul className="mdf-published-card__items">
          {card.items.map((item, index) => (
            <li key={`${item.orderId}:${item.detailId ?? index}`}>
              {item.detailNumber != null ? `№${item.detailNumber} ` : ''}
              {item.widthMm != null && item.heightMm != null ? `${item.widthMm}×${item.heightMm} ` : ''}
              × {item.quantity}
              {card.kind !== 'bath' && ` (распилено ${item.cut}/${item.quantity})`}
            </li>
          ))}
        </ul>
      )}
      {/* §5.6 finding 8: authorized membership + this card's own progress — ALWAYS rendered,
       * regardless of `stale`/kind/presentation (covers minimal cards and baths, whose composition
       * items can be empty). */}
      {card.memberQuantities.length > 0 && (
        <ul className="mdf-published-card__members">
          {card.memberQuantities.map((member) => (
            <li key={`${member.orderId}:${member.detailId}`}>
              {member.orderName ?? `Заказ ${member.orderId}`} · {member.quantity}
              {card.kind === 'bath'
                ? ` (закатано ${member.laminated}/${member.quantity})`
                : ` (распилено ${member.cut}/${member.quantity})`}
            </li>
          ))}
        </ul>
      )}
      {/* §5.6 finding 8: whole-position totals, separate from per-card progress — read straight
       * from the snapshot's single `positions` truth, so the same position shows the same totals
       * on every card that references it (never doubled). */}
      {card.positions.length > 0 && (
        <div className="mdf-published-card__positions">
          {card.positions.map((position) => (
            <Tooltip
              key={`${position.orderId}:${position.detailId}`}
              title={`Итого по позиции: требуется ${position.required}, распилено ${position.creditedCut}, закатано ${position.creditedRolled}, осталось ${position.remaining}`}
            >
              <Tag className="mdf-published-card__position-tag">
                {position.orderName ?? `Заказ ${position.orderId}`}: {position.creditedCut}/{position.required}
              </Tag>
            </Tooltip>
          ))}
        </div>
      )}
      {card.comments.length > 0 && (
        <div className="mdf-published-card__comments">
          {card.comments.map((comment, index) => (
            <p key={index}>
              {extractMdfCommentFileLinks(comment, commentCandidates).map((segment, segmentIndex) =>
                segment.kind === 'link' ? (
                  <a
                    key={segmentIndex}
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      onFocusCard(segment.target.kind, segment.target.id);
                    }}
                  >
                    {segment.text}
                  </a>
                ) : (
                  <React.Fragment key={segmentIndex}>{segment.text}</React.Fragment>
                ))}
            </p>
          ))}
        </div>
      )}
      <footer className="mdf-published-card__footer">
        <Tooltip title={moveDisabled ? card.commandDisabledReason ?? undefined : 'Переместить'}>
          <Dropdown
            disabled={moveDisabled || menuItems.length === 0}
            menu={{
              items: menuItems,
              onClick: ({ key }) => onMove(card, key as MdfSourceColumn, COLUMN_TITLE_BY_KEY.get(key) ?? key),
            }}
          >
            <a onClick={(event) => event.preventDefault()} className="mdf-published-card__move-trigger">
              Переместить…
            </a>
          </Dropdown>
        </Tooltip>
      </footer>
    </article>
  );
};
