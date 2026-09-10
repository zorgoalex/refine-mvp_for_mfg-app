import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Button, Checkbox, Drawer, Empty, Grid, Input, Modal, Select, Space, Spin, Tabs, Tag, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { CadGroup, CadVariant, JsonValue } from '@shared/cad-workspace';
import { recipesEqual, validateComposition } from '@shared/cad-workspace';
import { cadApi } from '../../api/cadApi';
import { ordersApi } from '../../api/ordersApi';
import { can } from '../../utils/permissions';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { useTabStore } from '../../stores/tabStore';
import { loadCadTabs, saveCadTabs } from './cadViewState';
import { useCadRecipeCatalog } from './useCadRecipeCatalog';
import { CadAutosave, type CadDraft } from './cadAutosave';
import { useCadPreview } from './useCadPreview';
import { CadCanvas, cadPathData } from './CadCanvas';
import { CadParameterField } from './CadParameterField';
import { CadSidePanel } from './CadSidePanel';
import { CadExportDialog } from './CadExportDialog';
import { CadImportDialog, CadMappingDialog } from './CadLibraryDialogs';
import './cad.css';

export function CadEditorPage() {
  const { orderId: rawId } = useParams(), orderId = Number(rawId), navigate = useNavigate();
  const activity = useKeepAlive(), active = activity.isActive && activity.documentVisible;
  const [search, setSearch] = useState(''), [debounced, setDebounced] = useState(''), [mapping, setMapping] = useState(false), [busy, setBusy] = useState(false);
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null);
  const leave = useRef<() => Promise<unknown>>(async () => undefined);
  const registerLeave = useCallback((fn: () => Promise<unknown>) => { leave.current = fn; }, []);
  const allowed = can('cad.view') && can('orders.view');
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setSelectedVariant(loadCadTabs(orderId)?.activeId ?? null); }, [orderId]);
  const orders = useQuery(['cad-order-picker', debounced], () => ordersApi.list({ search: debounced, page: 1, pageSize: 100 }), { enabled: allowed && active });
  const workspace = useQuery(['cad-workspace', orderId], () => cadApi.workspace(orderId), { enabled: allowed && orderId > 0 && active, retry: false });
  const variants = workspace.data?.variants ?? [];
  const variant = variants.find(v => v.id === selectedVariant) ?? variants.find(v => v.kind === 'working') ?? variants[0];
  const switchTo = async (fn: () => void) => { try { await leave.current(); fn(); } catch (e) { message.warning(e instanceof Error ? e.message : 'Сначала сохраните или разрешите конфликт изменений'); } };
  if (!allowed) return <Alert type="warning" message="Нет доступа к CAD" />;
  return <div className="cad-page cad-editor">
    <header className="cad-editor-header"><h1>Фрезеровки заказов</h1><Select aria-label="Выбрать заказ" showSearch filterOption={false} onSearch={setSearch} placeholder="Найти заказ" value={orderId || undefined} options={orders.data?.data.map(o => ({ value: o.orderId, label: o.orderName }))} onChange={id => void switchTo(() => navigate(`/cad/orders/${id}`))} />
      {can('references.manage') && <Button onClick={() => setMapping(true)}>Соответствия</Button>}</header>
    {workspace.isLoading && orderId > 0 && <Spin />}
    {workspace.isError && <Alert type="error" message="Не удалось открыть отрисовку" action={<Button onClick={() => void workspace.refetch()}>Повторить</Button>} />}
    {!orderId && <Empty description="Выберите заказ, чтобы отрисовать его детали и фрезеровки" />}
    {orderId > 0 && !variant && !workspace.isLoading && !workspace.isError && <Empty description="У заказа ещё нет отрисовки"><Button type="primary" disabled={!can('cad.edit')} loading={busy} onClick={async () => { setBusy(true); try { await cadApi.create(orderId); await workspace.refetch(); } catch { message.error('Не удалось отрисовать заказ'); } finally { setBusy(false); } }}>Отрисовать заказ</Button></Empty>}
    {variant && <CadEditorDocument key={variant.id} variant={variant} variants={variants} orderId={orderId} active={active} tabKey={activity.tabKey || `/cad/orders/${orderId}`} registerLeave={registerLeave} onActivate={id => setSelectedVariant(id)} />}
    <CadMappingDialog open={mapping} active={active} onClose={() => setMapping(false)} />
  </div>;
}

interface DocumentProps { variant: CadVariant; variants: CadVariant[]; orderId: number; active: boolean; tabKey: string;
  registerLeave: (fn: () => Promise<unknown>) => void; onActivate: (id: string) => void }
function CadEditorDocument({ variant, variants, orderId, active, tabKey, registerLeave, onActivate }: DocumentProps) {
  const queryClient = useQueryClient(), screens = Grid.useBreakpoint(), tablet = !screens.xl;
  const [queue] = useState(() => new CadAutosave(variant, cadApi.save));
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const { base, draft } = state;
  const [selected, setSelected] = useState<string[]>([]), [visible, setVisible] = useState<string[]>(variant.groups.slice(0, 20).map(g => g.id));
  const [multiSelect, setMultiSelect] = useState(false);
  const [advanced, setAdvanced] = useState(false), [trajectories, setTrajectories] = useState(false), [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set()), [dimension, setDimension] = useState<string | null>(null);
  const [panel, setPanel] = useState<'parts' | 'properties' | 'issues' | null>(null), [filter, setFilter] = useState(''), [scroll, setScroll] = useState(0);
  const [partsOpen, setPartsOpen] = useState(false), [propertiesOpen, setPropertiesOpen] = useState(false);
  const listScroll = useRef(0); listScroll.current = scroll;
  const listNode = useRef<HTMLDivElement>(null);
  const restoreListScroll = () => { if (listNode.current) listNode.current.scrollTop = listScroll.current; };
  useEffect(() => { if (!tablet && partsOpen) restoreListScroll(); }, [tablet, partsOpen]);
  const [importOpen, setImportOpen] = useState(false), [exportOpen, setExportOpen] = useState(false);
  const [clone, setClone] = useState<'clone' | 'refresh' | 'fork' | null>(null), [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<CadDraft[]>([]), [redo, setRedo] = useState<CadDraft[]>([]);
  const invalid = useRef(new Set<string>()), forkKey = useRef(crypto.randomUUID());
  const readOnly = base.kind === 'original' || !can('cad.edit'), technical = can('cad.technology');
  const dirty = state.status !== 'saved' || state.incomplete;
  const flush = useCallback(() => queue.flush(), [queue]);
  useEffect(() => { registerLeave(flush); return () => registerLeave(async () => undefined); }, [registerLeave, flush]);
  useEffect(() => () => queue.dispose(), [queue]);
  useEffect(() => queue.accept(variant), [queue, variant]);
  useEffect(() => {
    queryClient.setQueryData<{ workspaceId: string | null; variants: CadVariant[] }>(['cad-workspace', orderId], old => old ? { ...old, variants: old.variants.map(v => v.id === base.id && v.version < base.version ? base : v) } : old);
  }, [base, orderId, queryClient]);
  useEffect(() => { if (active) saveCadTabs(orderId, { activeId: base.id, openIds: variants.map(v => v.id) }); }, [active, base.id, variants, orderId]);
  useEffect(() => {
    useTabStore.getState().setDirty(tabKey, dirty);
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, tabKey]);
  useEffect(() => { useTabStore.getState().openTab({ key: `/cad/orders/${orderId}`, path: `/cad/orders/${orderId}`, label: `CAD · ${base.sources.find(s => s.orderId === orderId)?.orderName ?? orderId}`, resource: 'cad', preserveLabel: true }); }, [base.id, orderId]);
  const catalog = useCadRecipeCatalog(true, active, advanced);
  const run = useQuery(['cad-run', base.id, base.version], () => cadApi.run(base.id, base.version), { enabled: active, retry: false,
    refetchInterval: data => active && data?.run && ['queued', 'running'].includes(data.run.status) ? 2000 : false });
  const source = useQuery(['cad-source-status', base.id, base.version], () => cadApi.sourceStatus(base.id), { enabled: active, retry: false, refetchInterval: active ? 60000 : false });
  const wanted = useMemo(() => [...new Set([...selected, ...visible])], [selected, visible]);
  const preview = useCadPreview(base, draft, run.data?.job ?? null, active, wanted);
  const group = selected.length === 1 ? draft.groups.find(g => g.id === selected[0]) : undefined;
  const part = draft.sources.find(s => s.id === group?.sourceSnapshotId)?.parts.find(p => p.detailId === group?.detailId);
  const recipe = catalog.data?.recipes.find(r => r.code === group?.recipe?.code && r.version === group.recipe.version);
  const item = preview.scene.items.find(i => i.part_id === group?.id);
  const issues = useMemo(() => [
    ...validateComposition(draft.groups, draft.sources),
    ...draft.groups.filter(g => !g.recipe).map(g => ({ groupId: g.id, code: 'RECIPE_MISSING', message: 'Не выбрана фрезеровка. Выберите одобренный вариант.' })),
    ...preview.scene.items.flatMap(i => (i.result?.errors ?? []).map(e => ({ groupId: i.part_id, code: e.code, message: e.message ?? 'Параметры не подходят детали. Проверьте настройки фрезеровки.' }))),
  ], [draft, preview.scene.items]);
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); try { await fn(); } catch (e) { message.error(e instanceof Error ? e.message : 'Не удалось выполнить действие'); } finally { setBusy(false); } };
  const edit = (next: CadDraft, immediate = false) => { if (readOnly) return; setHistory(h => [...h.slice(-49), draft]); setRedo([]); queue.edit(next, immediate); };
  const changeGroup = (patch: Partial<CadGroup>) => { if (group) edit({ ...draft, groups: draft.groups.map(g => g.id === group.id ? { ...g, ...patch } : g) }); };
  const validity = useCallback((key: string, valid: boolean) => { if (valid) invalid.current.delete(key); else invalid.current.add(key); queue.setIncomplete(invalid.current.size > 0); }, [queue]);
  const select = (ids: string[]) => { if (state.incomplete) { message.warning('Завершите ввод параметра перед сменой детали'); return; } setSelected(ids); setDimension(null); };
  const toggleProperties = () => {
    if (propertiesOpen && state.incomplete) { message.warning('Сначала завершите ввод параметра'); return; }
    setPropertiesOpen(open => !open);
  };
  const activate = (id: string) => void act(async () => { await flush(); onActivate(id); });
  const recipeName = (g: CadGroup) => catalog.data?.recipes.find(r => r.code === g.recipe?.code && r.version === g.recipe.version)?.display_name ?? (g.recipe ? 'Сохранённая фрезеровка' : 'Нет фрезеровки');
  const fields = recipe ? Object.entries(recipe.parameter_schema).filter(([, s]) => advanced || s.manager_editable) : [];
  const layers = [...new Set(item?.result?.geometry?.milling.map(p => p.layer) ?? [])];
  const filtered = draft.groups.filter(g => { const p = draft.sources.find(s => s.id === g.sourceSnapshotId)?.parts.find(p => p.detailId === g.detailId); return `${p?.detailNumber} ${g.orderId} ${recipeName(g)}`.toLowerCase().includes(filter.toLowerCase()); });
  const firstRow = Math.max(0, Math.floor(scroll / 96) - 2), rows = filtered.slice(firstRow, firstRow + 14);
  const partsPanel = <><div className="cad-panel-title"><h2>Детали <span>{draft.groups.length}</span></h2><Button disabled={readOnly} onClick={() => setImportOpen(true)}>Добавить</Button></div>
    <Input.Search aria-label="Найти деталь" placeholder="Позиция или фрезеровка" value={filter} onChange={e => { setFilter(e.target.value); setScroll(0); }} />
    <Checkbox checked={multiSelect} onChange={e => setMultiSelect(e.target.checked)}>Выбрать несколько</Checkbox>
    <div className="cad-part-list" ref={listNode} onScroll={e => setScroll(e.currentTarget.scrollTop)}><div style={{ height: filtered.length * 96, position: 'relative' }}>{rows.map((g, i) => {
      const p = draft.sources.find(s => s.id === g.sourceSnapshotId)?.parts.find(p => p.detailId === g.detailId), drawn = preview.scene.items.find(i => i.part_id === g.id);
      return <button key={g.id} type="button" style={{ top: (firstRow + i) * 96 }} aria-pressed={selected.includes(g.id)} className={`cad-part-card ${selected.includes(g.id) ? 'selected' : ''}`} onClick={e => select(multiSelect || e.ctrlKey || e.shiftKey ? selected.includes(g.id) ? selected.filter(id => id !== g.id) : [...selected, g.id] : [g.id])}>
        <svg width="42" height="62" viewBox={`-8 -8 ${(p?.widthMm ?? 100) + 16} ${(p?.heightMm ?? 100) + 16}`} aria-hidden="true"><g transform={`translate(0 ${p?.heightMm ?? 100}) scale(1 -1)`}><rect width={p?.widthMm ?? 100} height={p?.heightMm ?? 100} fill="#f4e8ce" stroke="#87919c" strokeWidth={6} />{drawn?.result?.geometry?.milling.slice(0, 100).map(path => <path key={path.path_id} d={cadPathData(path)} fill="none" stroke="#9c7641" strokeWidth={5} />)}</g></svg>
        <span><strong>Позиция {p?.detailNumber} <small>×{g.quantity}</small></strong><span>{p?.widthMm} × {p?.heightMm} мм</span><small>{recipeName(g)}</small><small className={issues.some(i => i.groupId === g.id) ? 'cad-text-error' : ''}>{issues.some(i => i.groupId === g.id) ? 'Нужно исправить' : drawn?.status === 'succeeded' ? 'Предпросмотр' : 'Ещё не рассчитана'}</small></span></button>;
    })}</div></div><Button danger disabled={readOnly || !selected.length} onClick={() => { edit({ ...draft, groups: draft.groups.filter(g => !selected.includes(g.id)) }); setSelected([]); }}>Убрать выбранные из варианта</Button><p className="cad-hint">Исходные заказы не изменяются.</p></>;
  const inspector = <><div className="cad-panel-title"><h2>{group ? 'Деталь' : selected.length > 1 ? `Выбрано: ${selected.length}` : 'Свойства'}</h2></div>
    {group && part ? <><h3>Позиция {part.detailNumber}</h3><p>{part.widthMm} × {part.heightMm} × {part.thicknessMm ?? '?'} мм<br />{part.material}</p><p className="cad-hint">Заказ {draft.sources.find(s => s.id === group.sourceSnapshotId)?.orderName} · обкат: {part.edgeName || '—'}</p>
      {item?.status !== 'succeeded' && <Alert type="warning" message={item?.status === 'failed' ? 'Фрезеровка не рассчитана' : 'Ожидается предпросмотр'} description="Контур на поле ещё не подтверждает правильность фрезеровки." />}
      {item?.result?.visualization?.quality !== 'exact' && item?.status === 'succeeded' && <Alert type="info" message="Схематичный вид" description="Профиль фрезы отсутствует или не подтверждён. Показаны траектории; точный вид снятого материала недоступен." />}
      <label className="cad-field-label">Фрезеровка<Select aria-label="Фрезеровка детали" disabled={readOnly || state.incomplete} value={group.recipe ? `${group.recipe.code}@${group.recipe.version}` : undefined} placeholder="Выберите фрезеровку" options={catalog.data?.recipes.filter(r => r.manager_ready || technical).map(r => ({ value: `${r.code}@${r.version}`, label: `${r.display_name} · ${r.version}${r.manager_ready ? '' : ' · требует проверки'}` }))} onChange={value => { const r = catalog.data?.recipes.find(r => `${r.code}@${r.version}` === value); if (r) changeGroup({ recipe: { code: r.code, version: r.version, parameters: {} } }); }} /></label>
      {!recipesEqual(group.recipe, part.recipe) && <Tag color="blue">Отличается от исходной</Tag>}
      {fields.map(([key, schema]) => <CadParameterField key={`${group.id}:${recipe!.code}:${recipe!.version}:${key}`} name={key} schema={schema} value={group.recipe && Object.hasOwn(group.recipe.parameters, key) ? group.recipe.parameters[key] : schema.default} disabled={readOnly || !technical && !schema.manager_editable} bounded={!technical || !advanced} tools={recipe!.available_tools} onValidity={validity} onFocus={setDimension} onChange={(value: JsonValue) => { if (group.recipe) changeGroup({ recipe: { ...group.recipe, parameters: { ...group.recipe.parameters, [key]: value } } }); }} />)}
      {!advanced && !fields.length && <p className="cad-hint">Размеры фрезеровки рассчитываются автоматически. Технологические настройки скрыты.</p>}
      <CadParameterField key={`${group.id}:qty`} name="quantity" schema={{ type: 'number', default: 1, label: 'Количество', integer: true, nullable: false, manager_editable: true, min: 1, max: part.quantity }} value={group.quantity} bounded disabled={readOnly} tools={[]} onValidity={validity} onFocus={() => setDimension(null)} onChange={v => { if (typeof v === 'number') changeGroup({ quantity: v }); }} />
      <Button disabled={readOnly || group.quantity < 2 || state.incomplete} onClick={() => { const qty = Math.floor(group.quantity / 2), id = crypto.randomUUID(); edit({ ...draft, groups: [...draft.groups.map(g => g.id === group.id ? { ...g, quantity: g.quantity - qty } : g), { ...structuredClone(group), id, quantity: qty, xMm: group.xMm + part.widthMm + 50 }] }); setSelected([id]); }}>Разделить количество</Button>
      <details><summary>Положение на поле</summary>{(['xMm', 'yMm', 'rotationDeg'] as const).map(key => <CadParameterField key={`${group.id}:${key}`} name={key} schema={{ type: 'number', default: 0, label: key === 'xMm' ? 'По горизонтали' : key === 'yMm' ? 'По вертикали' : 'Поворот', unit: key === 'rotationDeg' ? '°' : 'мм', integer: false, nullable: false, manager_editable: true }} value={group[key]} bounded={false} disabled={readOnly} tools={[]} onValidity={validity} onFocus={() => setDimension(null)} onChange={v => { if (typeof v === 'number') changeGroup({ [key]: v }); }} />)}<Checkbox checked={expanded} onChange={e => setExpanded(e.target.checked)}>Показать экземпляры (до 200)</Checkbox></details>
      {advanced && <details><summary>Траектории и технические данные</summary>{layers.map(layer => <Checkbox key={layer} checked={!hidden.has(layer)} onChange={e => setHidden(old => { const next = new Set(old); if (e.target.checked) next.delete(layer); else next.add(layer); return next; })}>{layer}</Checkbox>)}{item?.result?.geometry?.milling.map(p => <p key={p.path_id} className="cad-hint">{p.layer} · {p.tool_id} · место {p.slot ?? '—'} · глубина {p.depth_mm ?? '—'} мм</p>)}<code className="cad-hash">{item?.snapshot_hash}</code></details>}
    </> : <p className="cad-hint">{selected.length > 1 ? 'Настройки фрезеровки доступны для одной детали. Выбранные детали можно перемещать вместе.' : 'Выберите деталь на поле или в списке.'}</p>}
    {selected.length > 1 && <Button disabled={readOnly} onClick={() => { const id = crypto.randomUUID(); edit({ ...draft, groups: draft.groups.map(g => selected.includes(g.id) ? { ...g, placementGroupId: id } : g) }); }}>Объединить перемещение</Button>}
    {selected.length > 0 && <Button disabled={readOnly} onClick={() => edit({ ...draft, groups: draft.groups.map(g => selected.includes(g.id) ? { ...g, placementGroupId: undefined } : g) })}>Разъединить перемещение</Button>}
  </>;
  return <>
    <Tabs className="cad-variant-tabs" activeKey={base.id} onChange={activate} items={variants.map(v => ({ key: v.id, label: `${v.kind === 'original' ? '🔒 ' : ''}${v.name}${v.id === base.id && dirty ? ' •' : ''}` }))} />
    <div className="cad-editor-toolbar"><div role="status" aria-live="polite">{base.kind === 'original' ? 'Оригинал · только просмотр' : state.incomplete ? 'Завершите ввод' : ({ saved: 'Все изменения сохранены', dirty: 'Есть изменения', saving: 'Сохраняем…', error: 'Не удалось сохранить', conflict: 'Конфликт версий' })[state.status]}</div>
      <Space wrap><Button disabled={!can('cad.edit') || busy} onClick={() => { setName(`Рабочая ${variants.length}`); setClone('clone'); }}>Новый вариант</Button>
        <Button aria-label="Отменить последнее изменение" disabled={readOnly || !history.length || state.incomplete} onClick={() => { const prev = history.at(-1); if (prev) { setRedo(r => [...r, draft]); setHistory(h => h.slice(0, -1)); queue.edit(prev); } }}>↶</Button><Button aria-label="Повторить изменение" disabled={readOnly || !redo.length || state.incomplete} onClick={() => { const next = redo.at(-1); if (next) { setHistory(h => [...h, draft]); setRedo(r => r.slice(0, -1)); queue.edit(next); } }}>↷</Button>
        <Checkbox checked={advanced} disabled={state.incomplete} onChange={e => setAdvanced(e.target.checked)}>Расширенный режим</Checkbox><Button type="primary" disabled={!can('cad.export') || state.incomplete || state.status === 'conflict'} onClick={() => setExportOpen(true)}>Скачать фрезеровки</Button></Space></div>
    {state.status === 'error' && <Alert type="error" message="Изменения остались в этой вкладке" description="Не закрывайте её. Повторное сохранение не создаст дубль." action={<Button loading={busy} onClick={() => void act(async () => { await flush(); })}>Повторить сохранение</Button>} />}
    {state.status === 'conflict' && <Alert type="warning" message="Коллега уже изменил этот вариант" description="Ваши изменения сохранены локально. Выберите отдельный вариант или загрузите изменения коллеги." action={<Space><Button onClick={() => { forkKey.current = crypto.randomUUID(); setName(`${base.name} · мои изменения`); setClone('fork'); }}>Сохранить мои в новый вариант</Button><Button onClick={() => Modal.confirm({ title: 'Отбросить мои несохранённые изменения?', content: 'Будет загружен текущий вариант коллеги.', onOk: async () => { const current = await cadApi.workspace(orderId); const fresh = current.variants.find(v => v.id === base.id); if (fresh) { invalid.current.clear(); queue.reset(fresh); setHistory([]); setRedo([]); await queryClient.invalidateQueries(['cad-workspace', orderId]); } } })}>Загрузить вариант коллеги</Button></Space>} />}
    {source.data?.some(s => s.stale) && <Alert type="warning" message="Исходные заказы изменились. Этот вариант сохранён без изменений." action={<Button disabled={!can('cad.edit')} onClick={() => { setName(`Актуальный состав ${variants.length}`); setClone('refresh'); }}>Новый вариант из актуальных данных</Button>} />}
    {source.isError && <Alert type="warning" message="Актуальность заказов пока не проверена" />}
    <div className="cad-view-bar"><Space>{tablet && <><Button aria-expanded={panel === 'parts'} onClick={() => setPanel('parts')}>Детали ({draft.groups.length})</Button><Button aria-expanded={panel === 'properties'} onClick={() => setPanel('properties')}>Свойства</Button></>}<Checkbox checked={trajectories} onChange={e => setTrajectories(e.target.checked)}>Траектории</Checkbox><span className="cad-hint">{preview.pending ? 'Обновляем предпросмотр…' : 'Вид детали · 2D'}</span></Space><Button aria-expanded={panel === 'issues'} type={issues.length ? 'default' : 'text'} danger={issues.length > 0} onClick={() => setPanel('issues')}>Проверки{issues.length ? ` (${issues.length})` : ''}</Button></div>
    {preview.error && <Alert type="warning" message={preview.error} />}
    <div className="cad-editor-layout">{!tablet && <CadSidePanel side="left" title={`Детали (${draft.groups.length})`} open={partsOpen} onToggle={() => setPartsOpen(open => !open)}>{partsPanel}</CadSidePanel>}
      {active ? <CadCanvas documentId={base.id} groups={draft.groups} sources={draft.sources} job={preview.scene} readOnly={readOnly} selected={selected} onSelect={select} onChange={groups => edit({ ...draft, groups }, true)} hiddenLayers={hidden} expanded={expanded} finished trajectories={trajectories} dimension={dimension} onVisible={setVisible} /> : <div className="cad-canvas-shell" />}
      {!tablet && <CadSidePanel side="right" title="Свойства" open={propertiesOpen} onToggle={toggleProperties}>{inspector}</CadSidePanel>}</div>
    <Drawer open={panel !== null} placement={panel === 'parts' ? 'left' : 'right'} width={Math.min(420, window.innerWidth)} title={panel === 'parts' ? 'Детали' : panel === 'properties' ? 'Свойства детали' : 'Что нужно проверить'} afterOpenChange={open => { if (open && panel === 'parts') restoreListScroll(); }} onClose={() => { if (state.incomplete) message.warning('Сначала завершите ввод параметра'); else setPanel(null); }}>
      {panel === 'parts' ? partsPanel : panel === 'properties' ? inspector : <>{!issues.length && <Alert type="info" message="Ошибок предпросмотра не обнаружено" description="Полная проверка всех деталей и одобрений выполняется перед скачиванием." />}{issues.map((i, n) => <div key={n} className="cad-export-issue"><p>{i.message}</p>{advanced && <code>{i.code}</code>}{i.groupId && <Button onClick={() => { if (state.incomplete) { message.warning('Сначала завершите ввод параметра'); return; } select([i.groupId!]); if (tablet) setPanel('properties'); else { setPanel(null); setPropertiesOpen(true); } }}>Перейти к детали</Button>}</div>)}<p className="cad-hint">Пунктирный контур означает, что фрезеровка ещё не рассчитана. Схематичный вид не заменяет проверку в CAM.</p></>}
    </Drawer>
    <Modal open={clone !== null} title={clone === 'fork' ? 'Сохранить мои изменения отдельно' : clone === 'refresh' ? 'Вариант из актуальных данных' : 'Новый рабочий вариант'} onCancel={() => setClone(null)} confirmLoading={busy} okButtonProps={{ disabled: !name.trim() }} onOk={() => void act(async () => {
      const next = clone === 'fork' ? await cadApi.fork(base, draft.groups, draft.sources.map(s => s.id), name, forkKey.current) : await cadApi.clone((await flush()).id, name, clone === 'refresh');
      await queryClient.invalidateQueries(['cad-workspace', orderId]); useTabStore.getState().setDirty(tabKey, false); setClone(null); onActivate(next.id);
    })}><Input aria-label="Имя нового варианта" value={name} maxLength={100} onChange={e => setName(e.target.value)} /><p>Оригинал и предыдущие варианты останутся неизменными.</p></Modal>
    <CadImportDialog open={importOpen} draft={draft} onChange={edit} onClose={() => setImportOpen(false)} />
    <CadExportDialog open={exportOpen} flush={flush} onClose={() => setExportOpen(false)} />
  </>;
}
