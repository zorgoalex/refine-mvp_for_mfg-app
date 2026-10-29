// «NewLine», mockup 07: summary under the board title and totals under each column header. Only what the loaded
// board already has (no extra requests): a column loads its first 24 cards, so card-based numbers say when they
// cover only part of the column.
import React from 'react';
import type {
  OrderStatusBoardColumn,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';
import { useOptionalUiVariant } from '../../ui-variant/UiVariantProvider';

const READY_STATUS_NAME = 'Готов к выдаче';

const shown = (column: OrderStatusBoardColumn) => column.cards.length;
const partial = (column: OrderStatusBoardColumn) => column.total > column.cards.length;

export interface BoardSummaryItem {
  key: 'total' | 'inWork' | 'overdue' | 'ready';
  label: string;
  value: string;
  tone?: 'danger' | 'success';
}

/** «в работе» (orders before «Выдан»), «просрочено», «готовы к выдаче» — order board; total and overdue — production. */
export function boardSummary(board: OrderStatusBoardType, columns: readonly OrderStatusBoardColumn[]): BoardSummaryItem[] {
  const total = columns.reduce((sum, column) => sum + column.total, 0);
  const overdue = columns.reduce((sum, column) => sum + column.cards.filter((card) => card.pastPlannedDate).length, 0);
  const overduePartial = columns.some(partial);
  const items: BoardSummaryItem[] = [];
  if (board === 'order') {
    // a column with orders has its first page loaded: the status of its cards tells «issued or later»
    const inWork = columns
      .filter((column) => column.cards.length > 0 && !column.cards[0].orderStatusIssuedOrLater)
      .reduce((sum, column) => sum + column.total, 0);
    items.push({ key: 'inWork', label: 'в работе', value: String(inWork) });
  } else {
    items.push({ key: 'total', label: 'заказов', value: String(total) });
  }
  items.push({
    key: 'overdue',
    label: 'просрочено',
    value: `${overduePartial && overdue > 0 ? '≥ ' : ''}${overdue}`,
    ...(overdue > 0 ? { tone: 'danger' as const } : {}),
  });
  if (board === 'order') {
    const ready = columns.find((column) => column.status.name === READY_STATUS_NAME);
    if (ready) items.push({ key: 'ready', label: 'готовы к выдаче', value: String(ready.total), ...(ready.total > 0 ? { tone: 'success' as const } : {}) });
  }
  return items;
}

const area = (value: number) => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }).replace(/[\u00a0\u202f]/g, ' ')} м²`;

const money = (value: number) => {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString('ru-RU', { maximumFractionDigits: 1 }).replace(/[\u00a0\u202f]/g, ' ')} млн ₸`;
  }
  return `${Math.round(value).toLocaleString('ru-RU').replace(/[\u00a0\u202f]/g, ' ')} ₸`;
};

/** «24 из 61 · 12,4 м² · 1,2 млн ₸» — over the loaded cards; money only with the financials right. */
export function columnTotalsLine(column: OrderStatusBoardColumn, showFinancials: boolean): string | null {
  if (column.cards.length === 0) return null;
  const totalArea = column.cards.reduce((sum, card) => sum + (Number(card.totalArea) || 0), 0);
  const amount = column.cards.reduce((sum, card) => sum + (Number(card.finalAmount) || 0), 0);
  const parts = [
    partial(column) ? `${shown(column)} из ${column.total}` : null,
    area(totalArea),
    showFinancials && column.cards.some((card) => card.finalAmount !== null) ? money(amount) : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

const useWorkbench = () => useOptionalUiVariant()?.variant === 'workbench';

export const WorkbenchBoardSummary: React.FC<{ board: OrderStatusBoardType; columns: readonly OrderStatusBoardColumn[] }> = ({ board, columns }) => {
  if (!useWorkbench() || columns.length === 0) return null;
  return (
    <div className="wb-board-summary" aria-label="Сводка доски">
      {boardSummary(board, columns).map((item) => (
        <span key={item.key} className="wb-board-summary__item" data-tone={item.tone}>
          <b>{item.value}</b> {item.label}
        </span>
      ))}
    </div>
  );
};

export const WorkbenchColumnTotals: React.FC<{ column: OrderStatusBoardColumn; showFinancials: boolean }> = ({ column, showFinancials }) => {
  const workbench = useWorkbench();
  const line = workbench ? columnTotalsLine(column, showFinancials) : null;
  if (!line) return null;
  return (
    <div
      className="wb-board-column-totals"
      title={partial(column) ? `По ${shown(column)} загруженным заказам из ${column.total}; остальные подгружаются при прокрутке` : undefined}
    >
      {line}
    </div>
  );
};
