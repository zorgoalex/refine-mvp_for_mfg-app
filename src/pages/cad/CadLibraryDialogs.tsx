import React, { useState } from 'react';
import { Alert, Button, InputNumber, Modal, Select, Space, message } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { CadSourceSnapshot } from '@shared/cad-workspace';
import { createGroups, validateComposition } from '@shared/cad-workspace';
import { cadApi } from '../../api/cadApi';
import { ordersApi } from '../../api/ordersApi';
import { useCadRecipeCatalog } from './useCadRecipeCatalog';
import type { CadDraft } from './cadAutosave';

export function CadMappingDialog({ open, active, onClose }: { open: boolean; active: boolean; onClose: () => void }) {
  const catalog = useCadRecipeCatalog(open, active, open);
  const mappings = useQuery(['cad-mappings'], cadApi.mappings, { enabled: open && active });
  const [busy, setBusy] = useState(false);
  return <Modal open={open} title="Соответствия фрезеровок ERP → CAD" footer={null} onCancel={onClose} width={760}>
    <p>Выберите полную одобренную версию. Сохранённые отрисовки не изменятся. Сами рецепты и профили настраиваются в CAD-сервисе.</p>
    <Space><span className="cad-hint">Список обновляется автоматически</span><Button loading={catalog.isFetching || mappings.isFetching} onClick={() => { void catalog.refetch(); void mappings.refetch(); }}>Обновить</Button></Space>
    {(catalog.isError || mappings.isError) && <Alert type="warning" message="Не удалось обновить данные. Показан последний доступный список." />}
    {catalog.data && !catalog.data.recipes.some(r => r.manager_ready) && <Alert type="info" message="Нет полных одобренных версий" description="Заполните обязательные параметры и одобрите версию в CAD-сервисе." />}
    {mappings.data?.map(m => <label className="cad-import-row" key={m.milling_type_id}><span>{m.milling_type_name}</span><Select aria-label={`Рецепт CAD: ${m.milling_type_name}`} style={{ width: 350 }} disabled={busy} value={m.recipe ? `${m.recipe.code}@${m.recipe.version}` : undefined} placeholder="Не сопоставлено" options={catalog.data?.recipes.filter(r => r.manager_ready).map(r => ({ value: `${r.code}@${r.version}`, label: `${r.display_name} · версия ${r.version}` }))} onChange={async value => {
      const r = catalog.data?.recipes.find(r => `${r.code}@${r.version}` === value); if (!r) return;
      setBusy(true); try { await cadApi.map(m.milling_type_id, { code: r.code, version: r.version, parameters: {} }, m.revision ?? 0); await mappings.refetch(); } catch { message.error('Не удалось сохранить соответствие. Обновите список и повторите.'); } finally { setBusy(false); }
    }} /></label>)}
  </Modal>;
}

export function CadImportDialog({ open, draft, onChange, onClose }: { open: boolean; draft: CadDraft; onChange: (d: CadDraft) => void; onClose: () => void }) {
  const [search, setSearch] = useState(''), [orderId, setOrderId] = useState<number | null>(null);
  const [source, setSource] = useState<CadSourceSnapshot | null>(null), [qty, setQty] = useState<Record<number, number>>({}), [busy, setBusy] = useState(false);
  const orders = useQuery(['cad-import-orders', search], () => ordersApi.list({ search, page: 1, pageSize: 50 }), { enabled: open });
  const add = () => {
    if (!source) return;
    const groups = createGroups([source], () => crypto.randomUUID()).filter(g => (qty[g.detailId] ?? 0) > 0).map(g => ({ ...g, quantity: qty[g.detailId], yMm: g.yMm + Math.max(0, ...draft.groups.map(g => g.yMm + 1000)) }));
    if (!groups.length) { message.warning('Укажите количество хотя бы одной позиции'); return; }
    const next = { sources: draft.sources.some(s => s.id === source.id) ? draft.sources : [...draft.sources, source], groups: [...draft.groups, ...groups] };
    const issues = validateComposition(next.groups, next.sources); if (issues.length) { message.error(issues[0].message); return; }
    onChange(next); setSource(null); onClose();
  };
  return <Modal open={open} title="Добавить детали другого заказа" onCancel={onClose} onOk={add} okText="Добавить в вариант" okButtonProps={{ disabled: !source }} width={700}>
    <p>Количество в исходных заказах не изменится.</p><Space wrap><Select aria-label="Заказ для добавления" showSearch filterOption={false} onSearch={setSearch} value={orderId} style={{ width: 300 }} options={orders.data?.data.map(o => ({ value: o.orderId, label: o.orderName }))} onChange={id => { setOrderId(id); setSource(null); }} />
      <Button disabled={!orderId} loading={busy} onClick={async () => { if (!orderId) return; setBusy(true); try {
        const s = draft.sources.find(s => s.orderId === orderId) ?? await cadApi.source(orderId); setSource(s);
        setQty(Object.fromEntries(s.parts.map(p => [p.detailId, Math.max(0, p.quantity - draft.groups.filter(g => g.orderId === s.orderId && g.detailId === p.detailId).reduce((n, g) => n + g.quantity, 0))])));
      } catch { message.error('Не удалось получить состав заказа'); } finally { setBusy(false); } }}>Получить состав</Button></Space>
    <div className="cad-import-list">{source?.parts.map(p => <label className="cad-import-row" key={p.detailId}><span>Позиция {p.detailNumber} · {p.widthMm} × {p.heightMm} мм · всего {p.quantity}</span><InputNumber aria-label={`Добавить количество позиции ${p.detailNumber}`} min={0} max={p.quantity} precision={0} value={qty[p.detailId] ?? 0} onChange={v => setQty(q => ({ ...q, [p.detailId]: v ?? 0 }))} /></label>)}</div>
  </Modal>;
}
