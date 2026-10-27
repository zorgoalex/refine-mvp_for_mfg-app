// «NewLine», mockup 03: quick view of an order on the right of the list. A click on a row opens it; it shows
// only what the list row already has (no new requests). «Открыть» (Ctrl+Enter) opens the card in a tab,
// «Изменить» (E) — the edit form, Esc closes the panel.
import React, { useEffect } from 'react';
import { Button, Drawer, Space } from 'antd';
import { EditOutlined, ExportOutlined } from '@ant-design/icons';
import { orderStatusTone, paymentStatusTone } from './orderListWorkbench';
import { workbenchDeadlineLine } from './mobile/workbenchOrderCardModel';

type Row = Record<string, unknown>;

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result : null;
};

const money = (value: unknown): string | null => {
  const amount = Number(value);
  return value === null || value === undefined || value === '' || !Number.isFinite(amount)
    ? null
    : `${Math.round(amount).toLocaleString('ru-RU').replace(/[  ]/g, ' ')} ₸`;
};

const day = (value: unknown): string | null => {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return parts ? `${parts[3]}.${parts[2]}.${parts[1]}` : null;
};

export interface QuickViewFact {
  label: string;
  value: string;
  tone?: string;
}

/** The facts of the panel, in the mockup order; empty values are left out, money only with the right. */
export function orderQuickViewFacts(row: Row, showFinancials: boolean, now: Date = new Date()): QuickViewFact[] {
  const facts: QuickViewFact[] = [];
  const push = (label: string, value: string | null, tone?: string) => {
    if (value) facts.push({ label, value, ...(tone ? { tone } : {}) });
  };
  push('Клиент', text(row.client_name));
  push('Проект', text(row.project_code));
  push('Дата заказа', day(row.order_date));
  const deadline = workbenchDeadlineLine(row, now);
  push('Срок', deadline ? `${day(row.planned_completion_date)} · ${deadline.text.replace(/^до [^·]+· /, '')}` : day(row.planned_completion_date), deadline?.tone);
  push('Производство', text(row.production_status_name));
  if (showFinancials) {
    push('Сумма', money(row.final_amount ?? row.total_amount));
    push('Оплачено', money(row.paid_amount));
    const total = Number(row.final_amount ?? row.total_amount);
    const paid = Number(row.paid_amount) || 0;
    if (Number.isFinite(total) && total > 0 && paid < total) push('Остаток', money(total - paid), paid > 0 ? 'warning' : 'danger');
  }
  const parts = Number(row.parts_count);
  const area = Number(row.total_area);
  const composition = [
    Number.isFinite(parts) && parts > 0 ? `${parts} дет.` : null,
    Number.isFinite(area) && area > 0 ? `${area.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м²` : null,
  ].filter(Boolean).join(' · ');
  push('Состав', composition || null);
  push('Материал', text(row.material_name));
  push('Плёнка', text(row.film_name));
  push('Фрезеровка', text(row.milling_type_name));
  push('Обкат', text(row.edge_type_name));
  push('Присадка', text(row.doweling_order_name));
  push('Примечание', text(row.notes));
  return facts;
}

/** Ctrl/⌘+Enter — open, E — edit (not while typing in a field). */
export function quickViewKeyAction(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; targetIsField?: boolean }): 'open' | 'edit' | null {
  if (event.targetIsField) return null;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) return 'open';
  if ((event.key === 'e' || event.key === 'E' || event.key === 'у' || event.key === 'У') && !event.ctrlKey && !event.metaKey && !event.altKey) return 'edit';
  return null;
}

export interface WorkbenchOrderQuickViewProps {
  row: Row | null;
  showFinancials: boolean;
  canEdit: boolean;
  onClose: () => void;
  onOpen: (orderId: number) => void;
  onEdit: (orderId: number) => void;
}

export const WorkbenchOrderQuickView: React.FC<WorkbenchOrderQuickViewProps> = ({ row, showFinancials, canEdit, onClose, onOpen, onEdit }) => {
  const orderId = row ? Number(row.order_id) : NaN;

  useEffect(() => {
    if (!row || !Number.isFinite(orderId)) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const targetIsField = Boolean(target?.closest('input, textarea, select, [contenteditable="true"], .ant-select'));
      const action = quickViewKeyAction({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, targetIsField });
      if (action === 'open') { event.preventDefault(); onOpen(orderId); }
      if (action === 'edit' && canEdit) { event.preventDefault(); onEdit(orderId); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, onEdit, onOpen, orderId, row]);

  const status = row ? text(row.order_status_name) : null;
  const payment = row && showFinancials ? text(row.payment_status_name) : null;

  return (
    <Drawer
      className="wb-order-quick"
      open={Boolean(row)}
      onClose={onClose}
      placement="right"
      width={400}
      mask={false}
      destroyOnClose
      title={row ? (
        <span className="wb-order-quick__title">
          <span>Заказ {text(row.order_name) ?? orderId}</span>
          {status ? <span className="wb-pill" data-tone={orderStatusTone(status)}>{status}</span> : null}
          {payment ? <span className="wb-pill" data-tone={paymentStatusTone(payment)}>{payment}</span> : null}
        </span>
      ) : null}
      footer={row ? (
        <Space>
          <Button type="primary" icon={<ExportOutlined />} onClick={() => onOpen(orderId)}>
            Открыть <span className="wb-order-quick__key">Ctrl Enter</span>
          </Button>
          {canEdit ? (
            <Button icon={<EditOutlined />} onClick={() => onEdit(orderId)}>
              Изменить <span className="wb-order-quick__key">E</span>
            </Button>
          ) : null}
        </Space>
      ) : null}
    >
      {row ? (
        <dl className="wb-order-quick__facts">
          {orderQuickViewFacts(row, showFinancials).map((fact) => (
            <React.Fragment key={fact.label}>
              <dt>{fact.label}</dt>
              <dd data-tone={fact.tone}>{fact.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </Drawer>
  );
};
