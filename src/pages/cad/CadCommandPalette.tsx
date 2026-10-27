import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Input, Modal, type InputRef } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { ordersApi } from '../../api/ordersApi';
import { filterCommands, type CadCommand } from './cadCommands';

interface Props { open: boolean; commands: CadCommand[]; onClose: () => void; onOpenOrder: (orderId: number) => void; currentOrderId: number }

/** Ctrl+K: every editor command by name, plus order search. Disabled commands stay visible so users learn they exist. */
export function CadCommandPalette({ open, commands, onClose, onOpenOrder, currentOrderId }: Props) {
  const [query, setQuery] = useState(''), [debounced, setDebounced] = useState(''), [cursor, setCursor] = useState(0);
  const input = useRef<InputRef>(null), list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    setQuery(''); setDebounced(''); setCursor(0);
    const timer = setTimeout(() => input.current?.focus(), 0); return () => clearTimeout(timer);
  }, [open]);
  useEffect(() => { const timer = setTimeout(() => setDebounced(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  const orders = useQuery(['cad-order-picker', debounced], () => ordersApi.list({ search: debounced, page: 1, pageSize: 8 }), { enabled: open && debounced.length >= 2 });
  const items = useMemo(() => {
    const found = filterCommands(commands, query);
    const orderItems: CadCommand[] = query.trim().length >= 2 ? (orders.data?.data ?? []).filter(o => o.orderId !== currentOrderId).slice(0, 8)
      .map(o => ({ id: `order:${o.orderId}`, group: 'Заказы', label: `Открыть заказ ${o.orderName}`, enabled: true, run: () => onOpenOrder(o.orderId) })) : [];
    return [...found, ...orderItems];
  }, [commands, query, orders.data, currentOrderId, onOpenOrder]);
  useEffect(() => { setCursor(n => Math.min(n, Math.max(0, items.length - 1))); }, [items.length]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: 'nearest' }); }, [cursor]);
  const runAt = (index: number) => { const item = items[index]; if (!item?.enabled) return; onClose(); item.run(); };
  let lastGroup = '';
  return <Modal className="cad-compact cad-palette" open={open} onCancel={onClose} footer={null} closable={false} width={560} destroyOnClose title={null}>
    <Input ref={input} autoFocus aria-label="Команда или заказ" placeholder="Команда или заказ…" value={query} role="combobox" aria-expanded aria-controls="cad-palette-list"
      aria-activedescendant={items[cursor] ? `cad-palette-${cursor}` : undefined}
      onChange={e => { setQuery(e.target.value); setCursor(0); }}
      onKeyDown={e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(n => Math.min(items.length - 1, n + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(n => Math.max(0, n - 1)); }
        else if (e.key === 'Enter') { e.preventDefault(); runAt(cursor); }
      }} />
    <div id="cad-palette-list" ref={list} role="listbox" aria-label="Команды" className="cad-palette-list">
      {!items.length && <p className="cad-hint">{orders.isFetching ? 'Ищем заказы…' : 'Ничего не найдено'}</p>}
      {items.map((item, index) => {
        const heading = item.group !== lastGroup ? item.group : null; lastGroup = item.group;
        return <React.Fragment key={item.id}>
          {heading && <div className="cad-palette-group" role="presentation">{heading}</div>}
          <div id={`cad-palette-${index}`} data-index={index} role="option" aria-selected={index === cursor} aria-disabled={!item.enabled}
            className={`cad-palette-item${index === cursor ? ' is-active' : ''}${item.enabled ? '' : ' is-disabled'}`}
            onMouseMove={() => setCursor(index)} onClick={() => runAt(index)}>
            <span>{item.label}</span>{item.keys && <kbd>{item.keys}</kbd>}
          </div>
        </React.Fragment>;
      })}
    </div>
  </Modal>;
}
