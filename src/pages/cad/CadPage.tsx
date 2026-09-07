import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Select, Space, Spin, Tabs, Tag, Typography, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { CadGroup, CadSourceSnapshot, CadVariant, JsonValue } from '@shared/cad-workspace';
import { createGroups, recipesEqual, validateComposition } from '@shared/cad-workspace';
import type { CadJob } from '@shared/cad-api';
import { cadApi } from '../../api/cadApi';
import { ordersApi } from '../../api/ordersApi';
import { can } from '../../utils/permissions';
import { useTabStore } from '../../stores/tabStore';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { CadCanvas } from './CadCanvas';
import { loadCadTabs, saveCadTabs } from './cadViewState';
import './cad.css';

interface Draft { groups: CadGroup[]; sources: CadSourceSnapshot[] }
export function CadPage() {
  const { orderId: rawId } = useParams(); const orderId = Number(rawId); const navigate = useNavigate();
  const activity = useKeepAlive(); const tabKey = activity.tabKey || (rawId ? `/cad/orders/${rawId}` : '/cad');
  const queryClient = useQueryClient(); const allowed = can('cad.view') && can('orders.view');
  const [search, setSearch] = useState(''); const [debounced, setDebounced] = useState('');
  const [variantId, setVariantId] = useState<string | null>(null); const [draft, setDraft] = useState<Draft | null>(null);
  const [openIds, setOpenIds] = useState<string[] | null>(null);
  const [history, setHistory] = useState<Draft[]>([]); const [redo, setRedo] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [selected, setSelected] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set()); const [expanded, setExpanded] = useState(false);
  const [importOpen, setImportOpen] = useState(false); const [importOrder, setImportOrder] = useState<number | null>(null);
  const [importSource, setImportSource] = useState<CadSourceSnapshot | null>(null); const [importQty, setImportQty] = useState<Record<number, number>>({});
  const [mappingOpen, setMappingOpen] = useState(false); const [versionName, setVersionName] = useState(''); const [cloneMode, setCloneMode] = useState<'clone' | 'refresh' | null>(null);
  const [lastJob, setLastJob] = useState<CadJob | null>(null);
  const active = activity.isActive && activity.documentVisible;
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(timer); }, [search]);
  const capabilities = useQuery(['cad-capabilities'], cadApi.capabilities, { enabled: allowed, retry: false });
  const enabled = allowed && capabilities.data?.enabled === true;
  const orders = useQuery(['cad-order-picker', debounced], () => ordersApi.list({ search: debounced, page: 1, pageSize: 100 }), { enabled: allowed });
  const workspace = useQuery(['cad-workspace', orderId], () => cadApi.workspace(orderId), { enabled: enabled && Number.isSafeInteger(orderId) && orderId > 0, retry: false });
  const catalog = useQuery(['cad-recipes'], cadApi.catalog, { enabled, retry: false });
  const mappings = useQuery(['cad-mappings'], cadApi.mappings, { enabled: enabled && mappingOpen });
  const variants = workspace.data?.variants ?? [];
  const variant = variants.find(v => v.id === variantId) ?? variants.find(v => v.kind === 'original');
  const visibleVariants = variants.filter(v => v.kind === 'original' || openIds === null || openIds.includes(v.id) || v.id === variantId);
  const readOnly = variant?.kind === 'original' || !can('cad.edit');
  const sourceStatus = useQuery(['cad-source-status', variant?.id, variant?.version], () => cadApi.sourceStatus(variant!.id), { enabled: enabled && active && Boolean(variant), refetchInterval: active ? 60000 : false, retry: false });
  const run = useQuery(['cad-run', variant?.id, variant?.version], () => cadApi.run(variant!.id, variant!.version), {
    enabled: enabled && active && Boolean(variant), retry: false, staleTime: 30000,
    refetchInterval: data => data?.run && (['queued', 'running'].includes(data.run.status) || data.run.packageRequested && !data.run.packageId && !data.run.lastError) ? 2000 : false,
  });
  useEffect(() => { const tabs = loadCadTabs(orderId); setVariantId(tabs?.activeId ?? null); setOpenIds(tabs?.openIds ?? null); setDraft(null); setDirty(false); setLastJob(null); }, [orderId]);
  useEffect(() => { if (variant && active) saveCadTabs(orderId, { activeId: variant.id, openIds: visibleVariants.map(v => v.id) }); }, [orderId, variant?.id, openIds, active]);
  useEffect(() => { if (variant && !dirty) { setDraft({ groups: variant.groups, sources: variant.sources }); setHistory([]); setRedo([]); } }, [variant?.id, variant?.version, dirty]);
  useEffect(() => { if (run.data?.job) setLastJob(run.data.job); }, [run.data?.job]);
  useEffect(() => { setLastJob(null); setSelected([]); }, [variant?.id]);
  useEffect(() => { useTabStore.getState().setDirty(tabKey, dirty); const listener = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', listener); return () => window.removeEventListener('beforeunload', listener); }, [dirty, tabKey]);
  useEffect(() => {
    if (variant) useTabStore.getState().openTab({ key: `/cad/orders/${orderId}`, path: `/cad/orders/${orderId}`, label: `CAD · ${variant.sources.find(s => s.orderId === orderId)?.orderName ?? orderId}`, resource: 'cad', preserveLabel: true });
  }, [orderId, variant?.id]);
  const current = draft ?? (variant ? { groups: variant.groups, sources: variant.sources } : null);
  const issues = useMemo(() => current ? validateComposition(current.groups, current.sources) : [], [current]);
  const group = current?.groups.find(g => g.id === selected[0]);
  const sourcePart = current?.sources.find(s => s.id === group?.sourceSnapshotId)?.parts.find(p => p.detailId === group?.detailId);
  const recipe = catalog.data?.recipes.find(r => r.code === group?.recipe?.code && r.version === group.recipe.version);
  const job = run.data?.job ?? lastJob;
  // Never show old milling as if it belonged to an edited recipe/source.
  const sceneJob = useMemo(() => job ? { ...job, items: job.items.filter(item => {
    const effective = current?.groups.find(g => g.id === item.part_id);
    const saved = variant?.groups.find(g => g.id === item.part_id);
    return effective && saved && effective.sourceSnapshotId === saved.sourceSnapshotId &&
      recipesEqual(effective.recipe, item.result?.input_recipe);
  }) } : null, [job, current, variant]);
  const layers = [...new Set(job?.items.flatMap(i => [...(i.result?.geometry?.boundaries ?? []), ...(i.result?.geometry?.milling ?? [])].map(p => p.layer)) ?? [])];
  const toolHints = [...new Map((sceneJob?.items.find(i => i.part_id === group?.id)?.result?.geometry?.milling ?? [])
    .map(p => [`${p.layer}:${p.tool_id}:${p.slot}:${p.depth_mm}`, p])).values()];
  const optionList = orders.data?.data.map(o => ({ value: o.orderId, label: `${o.orderName} · ${o.clientName ?? ''}` })) ?? [];
  const edit = (next: Draft) => { if (readOnly || !current) return; setHistory(h => [...h.slice(-49), current]); setRedo([]); setDraft(next); setDirty(true); };
  const changeGroups = (groups: CadGroup[]) => { if (current) edit({ ...current, groups }); };
  const changeGroup = (patch: Partial<CadGroup>) => { if (current && group) changeGroups(current.groups.map(g => g.id === group.id ? { ...g, ...patch } : g)); };
  const field = (name: string, value: JsonValue) => { if (group?.recipe) changeGroup({ recipe: { ...group.recipe, parameters: { ...group.recipe.parameters, [name]: value } } }); };
  const action = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); try { await fn(); } catch (error) { message.error(error instanceof Error ? error.message : 'Ошибка CAD'); } finally { setBusy(false); } };
  const refresh = () => queryClient.invalidateQueries(['cad-workspace', orderId]);
  const activate = (id: string) => { const apply = () => { setDirty(false); setDraft(null); setVariantId(id); }; if (dirty) Modal.confirm({ title: 'Переключить версию без сохранения изменений?', onOk: apply }); else apply(); };
  const closeVersion = (id: string) => { const apply = () => { setOpenIds(visibleVariants.filter(v => v.id !== id).map(v => v.id)); if (variant?.id === id) { setDirty(false); setDraft(null); setVariantId(variants.find(v => v.kind === 'original')?.id ?? null); } }; if (dirty && variant?.id === id) Modal.confirm({ title: 'Закрыть вкладку без сохранения изменений?', content: 'Сохранённая версия останется доступна.', onOk: apply }); else apply(); };
  const save = async (): Promise<CadVariant | undefined> => { if (!variant || !current || readOnly) return; const next = await cadApi.save(variant, current.groups, current.sources.map(s => s.id)); setDirty(false); setDraft(null); await refresh(); return next; };
  const loadSource = () => action(async () => { if (!importOrder) return; const s = current?.sources.find(s => s.orderId === importOrder) ?? await cadApi.source(importOrder); setImportSource(s); const qty: Record<number, number> = {}; for (const p of s.parts) qty[p.detailId] = Math.max(0, p.quantity - (current?.groups.filter(g => g.orderId === s.orderId && g.detailId === p.detailId).reduce((sum, g) => sum + g.quantity, 0) ?? 0)); setImportQty(qty); });
  const importParts = () => { if (!current || !importSource) return; const added = createGroups([importSource], () => crypto.randomUUID()).filter(g => (importQty[g.detailId] ?? 0) > 0).map(g => ({ ...g, quantity: importQty[g.detailId], yMm: g.yMm + Math.max(0, ...current.groups.map(v => v.yMm + 1000)) })); const next = { sources: current.sources.some(s => s.id === importSource.id) ? current.sources : [...current.sources, importSource], groups: [...current.groups, ...added] }; const errors = validateComposition(next.groups, next.sources); if (errors.length) { message.error(errors[0].message); return; } edit(next); setImportOpen(false); setImportSource(null); };
  if (!allowed) return <Alert type="warning" message="Нет доступа к CAD-подготовке заказов" />;
  return <div className="cad-page">
    <header className="cad-header"><div><Typography.Title level={3}>Фрезеровки заказов</Typography.Title><Typography.Text type="secondary">Оригинал сохраняется. Рабочие версии могут объединять детали разных заказов.</Typography.Text></div>
      <Select aria-label="Выбрать заказ" showSearch filterOption={false} onSearch={setSearch} options={optionList} value={orderId || undefined} placeholder="Найти заказ" style={{ minWidth: 250 }} onChange={id => { if (dirty) { message.warning('Сначала сохраните изменения рабочей версии'); return; } navigate(`/cad/orders/${id}`); }} />
      {can('references.manage') && <Button onClick={() => setMappingOpen(true)} disabled={!enabled}>Соответствия фрезеровок</Button>}
    </header>
    {capabilities.isLoading ? <Spin /> : capabilities.error ? <Alert type="error" message="CAD API недоступен" description={String(capabilities.error)} /> : !enabled ? <Alert type="info" message="CAD-подготовка пока выключена в настройках сервера" /> : null}
    {workspace.error && <Alert type="error" message="Не удалось открыть заказ" description={String(workspace.error)} />}
    {enabled && orderId > 0 && !variant && !workspace.isLoading && <Empty description="У заказа ещё нет сохранённой отрисовки"><Button type="primary" disabled={!can('cad.edit')} loading={busy} onClick={() => void action(async () => { await cadApi.create(orderId); await refresh(); })}>Отрисовать заказ</Button></Empty>}
    {variant && current && <>
      <Tabs type="editable-card" hideAdd activeKey={variant.id} onChange={activate} onEdit={(key, action) => { if (action === 'remove' && typeof key === 'string') closeVersion(key); }} items={visibleVariants.map(v => ({ key: v.id, closable: v.kind !== 'original', label: <span>{v.kind === 'original' ? '🔒 ' : ''}{v.name}{dirty && v.id === variant.id ? ' •' : ''}</span> }))} />
      <Space className="cad-toolbar" wrap>
        <Tag color={readOnly ? 'default' : dirty ? 'orange' : 'green'}>{variant.kind === 'original' ? 'Оригинал · только просмотр' : dirty ? 'Не сохранено' : `Сохранено · редакция ${variant.version}`}</Tag>
        <Select aria-label="Открыть сохранённую версию" placeholder="Открыть версию" value={null} style={{ minWidth: 170 }} options={variants.map(v => ({ value: v.id, label: v.name }))} onChange={id => { setOpenIds(ids => [...new Set([...(ids ?? visibleVariants.map(v => v.id)), id])]); activate(id); }} />
        <Button disabled={!can('cad.edit') || dirty} onClick={() => { setVersionName(`Рабочая ${variants.length}`); setCloneMode('clone'); }}>Создать версию</Button>
        <Button disabled={!can('cad.edit') || dirty} onClick={() => { setVersionName(`Актуальные данные ${variants.length}`); setCloneMode('refresh'); }}>Версия по актуальным заказам</Button>
        <Button aria-label="Сохранить" type="primary" disabled={readOnly || !dirty || busy} loading={busy} onClick={() => void action(async () => { await save(); })}>Сохранить</Button>
        <Button disabled={readOnly || !history.length} onClick={() => { const prev = history.at(-1); if (prev) { setRedo(r => [...r, current]); setDraft(prev); setHistory(h => h.slice(0, -1)); setDirty(true); } }}>Отменить</Button>
        <Button disabled={readOnly || !redo.length} onClick={() => { const next = redo.at(-1); if (next) { setHistory(h => [...h, current]); setDraft(next); setRedo(r => r.slice(0, -1)); setDirty(true); } }}>Повторить</Button>
        <Button disabled={readOnly || busy} onClick={() => void action(async () => { const target = dirty ? await save() : variant; if (target) { await cadApi.render(target); await queryClient.invalidateQueries(['cad-run']); } })}>Рассчитать редакцию</Button>
        <Button disabled={dirty || !can('cad.export') || run.data?.run?.status !== 'succeeded'} loading={busy} onClick={() => void action(async () => { await cadApi.package(variant); await run.refetch(); })}>Подготовить ZIP версии</Button>
        {run.data?.run?.packageId && <Button disabled={dirty || !can('cad.export')} onClick={() => void action(() => cadApi.download(run.data!.run!.id, run.data!.run!.packageId!, `cad-${orderId}-${variant.name}.zip`))}>Скачать ZIP</Button>}
        {job?.package_files.filter(f => f.name === 'manifest.json').map(file => <Button key={file.id} disabled={dirty || !can('cad.export')} onClick={() => void action(() => cadApi.download(run.data!.run!.id, file.id, 'manifest.json'))}>manifest.json</Button>)}
      </Space>
      {job && <p className="cad-progress" role="status">Расчёт: {job.completed}/{job.total} · {job.status}{dirty ? ' · показан сохранённый результат; изменения требуют проверки' : ''}</p>}
      {run.error && <Alert type="error" message="Не удалось получить результат CAD" description={String(run.error)} />}
      {sourceStatus.data?.some(s => s.stale) && <Alert type="warning" message="Исходные заказы изменились" description={`Заказы: ${sourceStatus.data.filter(s => s.stale).map(s => s.orderId).join(', ')}. Сохранённая геометрия не меняется. Для обновления создайте версию по актуальным заказам.`} />}
      {sourceStatus.error && <Alert type="warning" message="Актуальность источников не проверена" description="Снимок сохранён; проверьте доступность исходных заказов." />}
      {run.data?.run?.lastError && <Alert type="warning" message={run.data.run.lastError} description="Проверьте диагностику и одобрение рецепта в CAD-сервисе." />}
      {issues.length > 0 && <Alert type="warning" message={`Конфликты состава: ${issues.length}`} description={issues.slice(0, 5).map(i => i.message).join('; ')} />}
      <div className="cad-layout">
        <aside className="cad-panel"><Space wrap><Button disabled={readOnly} onClick={() => setImportOpen(true)}>Добавить из заказа</Button><Button disabled={readOnly || !selected.length} onClick={() => changeGroups(current.groups.filter(g => !selected.includes(g.id)))}>Убрать выбранное</Button></Space>
          <p className="cad-hint">Это состав версии, не изменение исходных заказов.</p>
          <div className="cad-composition">{current.groups.map(g => { const p = current.sources.find(s => s.id === g.sourceSnapshotId)?.parts.find(p => p.detailId === g.detailId); return <button className={`cad-part-row ${selected.includes(g.id) ? 'selected' : ''}`} key={g.id} onClick={e => setSelected(e.ctrlKey || e.shiftKey ? [...new Set([...selected, g.id])] : [g.id])}>
            <strong>№{g.orderId} / {p?.detailNumber ?? '?'}</strong><span>{p?.widthMm} × {p?.heightMm} · {g.quantity} шт.</span><small>{g.recipe?.code ?? 'Нет соответствия CAD'}{JSON.stringify(g.recipe) !== JSON.stringify(p?.recipe) ? ' · изменено' : ''}</small>
          </button>; })}</div>
        </aside>
        {active && <CadCanvas key={variant.id} documentId={variant.id} groups={current.groups} sources={current.sources} job={sceneJob} readOnly={readOnly} selected={selected} onSelect={setSelected} onChange={changeGroups} hiddenLayers={hidden} expanded={expanded} />}
        <aside className="cad-panel"><Typography.Title level={5}>Свойства и слои</Typography.Title>
          {group && sourcePart ? <>
            <p>Заказ №{group.orderId} · позиция {sourcePart.detailNumber}<br />{sourcePart.widthMm} × {sourcePart.heightMm} мм · {sourcePart.thicknessMm ?? '?'} мм<br />{sourcePart.material}</p>
            <p className="cad-hint">Исходная: {sourcePart.millingName}<br />Обкат: {sourcePart.edgeName || '—'} · справочно, без траекторий</p>
            {sceneJob?.items.find(i => i.part_id === group.id)?.snapshot_hash && <Typography.Paragraph className="cad-hint" copyable={{ text: sceneJob.items.find(i => i.part_id === group.id)!.snapshot_hash! }}>Хеш проверки CAD: <code>{sceneJob.items.find(i => i.part_id === group.id)!.snapshot_hash}</code></Typography.Paragraph>}
            {toolHints.map(p => <p className="cad-tool-hint" key={`${p.layer}:${p.tool_id}:${p.slot}:${p.depth_mm}`}><strong>{p.layer}</strong><br />Слот: {p.slot ?? '—'} · {p.tool_id ?? 'фреза не указана'}<br />Глубина: {p.depth_mm ?? '—'} мм</p>)}
            <label>Количество в группе<InputNumber aria-label="Количество в группе" min={1} max={sourcePart.quantity} value={group.quantity} disabled={readOnly} onChange={value => { if (value) changeGroup({ quantity: value }); }} /></label>
            <Button disabled={readOnly || group.quantity < 2} onClick={() => { const qty = Math.floor(group.quantity / 2); const id = crypto.randomUUID(); changeGroups([...current.groups.map(g => g.id === group.id ? { ...g, quantity: g.quantity - qty } : g), { ...structuredClone(group), id, quantity: qty, xMm: group.xMm + sourcePart.widthMm + 50 }]); setSelected([id]); }}>Разделить количество</Button>
            <label>Фрезеровка рабочей версии<Select aria-label="Фрезеровка рабочей версии" style={{ width: '100%' }} disabled={readOnly} value={group.recipe ? `${group.recipe.code}@${group.recipe.version}` : undefined} options={catalog.data?.recipes.map(r => ({ value: `${r.code}@${r.version}`, label: `${r.display_name} · ${r.version} · ${r.status}` }))} onChange={value => { const r = catalog.data?.recipes.find(r => `${r.code}@${r.version}` === value); if (r) changeGroup({ recipe: { code: r.code, version: r.version, parameters: {} } }); }} /></label>
            {recipe && Object.entries(recipe.parameter_schema).map(([name, schema]) => { const value = group.recipe?.parameters[name] ?? schema.default; return <label key={`${group.id}-${recipe.code}-${recipe.version}-${name}`}>{name}
              {schema.type === 'number' ? <InputNumber aria-label={name} disabled={readOnly} value={typeof value === 'number' ? value : null} onChange={v => { if (v != null) field(name, v); }} /> : schema.type === 'boolean' ? <Checkbox disabled={readOnly} checked={value === true} onChange={e => field(name, e.target.checked)} /> : <Input aria-label={name} disabled={readOnly} defaultValue={typeof value === 'string' ? value : JSON.stringify(value)} onBlur={e => { try { field(name, schema.type === 'array' || schema.type === 'object' ? JSON.parse(e.target.value) : e.target.value); } catch { message.error(`Некорректное значение ${name}`); } }} />}
            </label>; })}
            <label>Поворот на поле, °<InputNumber disabled={readOnly} value={group.rotationDeg} onChange={v => { if (v != null) changeGroup({ rotationDeg: v }); }} /></label>
            <Space wrap><Button disabled={readOnly || selected.length < 2} onClick={() => { const id = crypto.randomUUID(); changeGroups(current.groups.map(g => selected.includes(g.id) ? { ...g, placementGroupId: id } : g)); }}>Группировать</Button><Button disabled={readOnly} onClick={() => changeGroups(current.groups.map(g => selected.includes(g.id) ? { ...g, placementGroupId: undefined } : g))}>Разгруппировать</Button></Space>
            <Checkbox checked={expanded} onChange={e => setExpanded(e.target.checked)}>Показать экземпляры выбранной группы (до 200)</Checkbox>
            {job?.items.find(i => i.part_id === group.id)?.result?.errors?.map((e, n) => <Alert key={n} type="error" message={e.code} description={e.message} />)}
            {job?.items.find(i => i.part_id === group.id)?.result?.warnings?.map((e, n) => <Alert key={n} type="warning" message={e.code} description={e.message} />)}
            {run.data?.run?.packageId && job?.items.find(i => i.part_id === group.id)?.result?.files?.map(file => <Button key={file.id} disabled={dirty || !can('cad.export')} onClick={() => void action(() => cadApi.download(run.data!.run!.id, file.id, file.name.split('/').at(-1) ?? file.id))}>{file.name.endsWith('.svg') ? 'SVG детали' : 'DXF детали'}</Button>)}
          </> : <p className="cad-hint">Выберите деталь на поле или в составе.</p>}
          <Typography.Title level={5}>Слои</Typography.Title>{layers.map(layer => <label key={layer}><Checkbox checked={!hidden.has(layer)} onChange={e => setHidden(old => { const next = new Set(old); if (e.target.checked) next.delete(layer); else next.add(layer); return next; })}>{layer}</Checkbox></label>)}
        </aside>
      </div>
    </>}
    <Modal open={cloneMode !== null} title={cloneMode === 'refresh' ? 'Новая версия по актуальным данным ERP' : 'Создать рабочую версию'} onCancel={() => setCloneMode(null)} confirmLoading={busy} onOk={() => void action(async () => { if (!variant || !cloneMode) return; const next = await cadApi.clone(variant.id, versionName, cloneMode === 'refresh'); await refresh(); setVariantId(next.id); setCloneMode(null); })}><Input aria-label="Имя версии" value={versionName} onChange={e => setVersionName(e.target.value)} /><p>Оригинал и предыдущие версии останутся без изменений.</p></Modal>
    <Modal open={importOpen} title="Добавить детали другого заказа" onCancel={() => setImportOpen(false)} onOk={importParts} okButtonProps={{ disabled: !importSource }} width={700}>
      <Space><Select aria-label="Исходный заказ" showSearch filterOption={false} onSearch={setSearch} options={optionList} value={importOrder} onChange={id => { setImportOrder(id); setImportSource(null); }} style={{ width: 300 }} /><Button loading={busy} onClick={() => void loadSource()}>Получить состав</Button></Space>
      <div className="cad-import-list">{importSource?.parts.map(p => <label className="cad-import-row" key={p.detailId}><span>#{p.detailNumber} · {p.widthMm} × {p.heightMm} · всего {p.quantity}</span><InputNumber aria-label={`Количество позиции ${p.detailNumber}`} min={0} max={p.quantity} value={importQty[p.detailId] ?? 0} onChange={v => setImportQty(q => ({ ...q, [p.detailId]: v ?? 0 }))} /></label>)}</div>
    </Modal>
    <Modal open={mappingOpen} title="Соответствия ERP → CAD" footer={null} onCancel={() => setMappingOpen(false)} width={850}>
      <p>Только одобренные версии CAD. Изменения не затронут сохранённые оригиналы.</p>
      {mappings.data?.map(m => <label key={m.milling_type_id} className="cad-import-row"><span>{m.milling_type_name}</span><Select style={{ width: 380 }} value={m.recipe ? `${m.recipe.code}@${m.recipe.version}` : undefined} placeholder="Не сопоставлено" disabled={busy} options={catalog.data?.recipes.filter(r => r.status === 'production').map(r => ({ value: `${r.code}@${r.version}`, label: `${r.display_name} · ${r.version}` }))} onChange={value => void action(async () => { const r = catalog.data?.recipes.find(r => `${r.code}@${r.version}` === value); if (r) { await cadApi.map(m.milling_type_id, { code: r.code, version: r.version, parameters: {} }, m.revision ?? 0); await mappings.refetch(); } })} /></label>)}
    </Modal>
  </div>;
}
