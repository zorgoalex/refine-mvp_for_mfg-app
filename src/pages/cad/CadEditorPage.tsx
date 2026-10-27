import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Dropdown, Empty, Grid, Input, Modal, Select, Space, Spin, Tabs, message } from 'antd';
import { EllipsisOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useKBar } from '@refinedev/kbar';
import { useNavigate, useParams } from 'react-router-dom';
import type { CadVariant } from '@shared/cad-workspace';
import { cadApi } from '../../api/cadApi';
import { ordersApi } from '../../api/ordersApi';
import { can } from '../../utils/permissions';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { Segmented } from '../../ui/Segmented';
import { Tooltip } from '../../ui/tooltipDelay';
import { loadCadTabs } from './cadViewState';
import { CadCanvas, type CadTool } from './CadCanvas';
import { CadSidePanel } from './CadSidePanel';
import { CadExportDialog } from './CadExportDialog';
import { CadImportDialog, CadMappingDialog } from './CadLibraryDialogs';
import { CadInspector, CadIssueList } from './CadInspector';
import { CadCompositionTree, useCadTreeState } from './CadCompositionTree';
import { CadCommandPalette } from './CadCommandPalette';
import { findShortcut, isTextTarget, type CadCommand } from './cadCommands';
import { useCadEditorController, type CadEditorController } from './useCadEditorController';
import './cad.css';

export function CadEditorPage() {
  const editorRoot = useRef<HTMLDivElement>(null);
  const { orderId: rawId } = useParams(), orderId = Number(rawId), navigate = useNavigate();
  const activity = useKeepAlive(), active = activity.isActive && activity.documentVisible;
  useEffect(() => {
    if (!active || !editorRoot.current) return;
    const root = editorRoot.current;
    const footer = document.querySelector('.ant-layout-footer');
    const fitHeight = () => {
      const reserved = footer?.getBoundingClientRect().height ?? 40;
      root.style.height = `${Math.max(360, window.innerHeight - root.getBoundingClientRect().top - reserved - 8)}px`;
    };
    const observer = new ResizeObserver(fitHeight);
    observer.observe(root.parentElement ?? root); if (footer) observer.observe(footer);
    window.addEventListener('resize', fitHeight); fitHeight();
    return () => { observer.disconnect(); window.removeEventListener('resize', fitHeight); };
  }, [active]);
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
  const openOrder = useCallback((id: number) => void switchTo(() => navigate(`/cad/orders/${id}`)), [navigate]);
  const orderPicker = <header className="cad-editor-header"><h1>CAD</h1><Select popupClassName="cad-compact" aria-label="Выбрать заказ" showSearch filterOption={false} onSearch={setSearch} placeholder="Найти заказ" value={orderId || undefined} options={orders.data?.data.map(o => ({ value: o.orderId, label: o.orderName }))} onChange={openOrder} /></header>;
  if (!allowed) return <Alert type="warning" message="Нет доступа к CAD" />;
  return <div ref={editorRoot} className="cad-page cad-editor">
    {!variant && <div className="cad-topbar">{orderPicker}{can('references.manage') && <Button className="cad-topbar-end" onClick={() => setMapping(true)}>Соответствия</Button>}</div>}
    {workspace.isLoading && orderId > 0 && <Spin />}
    {workspace.isError && <Alert type="error" message="Не удалось открыть отрисовку" action={<Button onClick={() => void workspace.refetch()}>Повторить</Button>} />}
    {!orderId && <Empty description="Выберите заказ, чтобы отрисовать его детали и фрезеровки" />}
    {orderId > 0 && !variant && !workspace.isLoading && !workspace.isError && <Empty description="У заказа ещё нет отрисовки"><Button type="primary" disabled={!can('cad.edit')} loading={busy} onClick={async () => { setBusy(true); try { await cadApi.create(orderId); await workspace.refetch(); } catch { message.error('Не удалось отрисовать заказ'); } finally { setBusy(false); } }}>Отрисовать заказ</Button></Empty>}
    {variant && <CadEditorDocument orderPicker={orderPicker} onMapping={() => setMapping(true)} onOpenOrder={openOrder} key={variant.id} variant={variant} variants={variants} orderId={orderId} active={active} tabKey={activity.tabKey || `/cad/orders/${orderId}`} registerLeave={registerLeave} onActivate={id => setSelectedVariant(id)} />}
    <CadMappingDialog open={mapping} active={active} onClose={() => setMapping(false)} />
  </div>;
}

interface DocumentProps { orderPicker: React.ReactNode; onMapping: () => void; onOpenOrder: (orderId: number) => void; variant: CadVariant; variants: CadVariant[]; orderId: number; active: boolean; tabKey: string;
  registerLeave: (fn: () => Promise<unknown>) => void; onActivate: (id: string) => void }
type RightTab = 'properties' | 'issues';

/** «Мастерская»: верхняя панель, тулбар, состав | холст | свойства, статус-бар. Логика документа — в контроллере. */
function CadEditorDocument({ orderPicker, onMapping, onOpenOrder, ...props }: DocumentProps) {
  const c = useCadEditorController(props);
  const { state, base, draft, variants, readOnly, selected, issues } = c;
  const screens = Grid.useBreakpoint(), tablet = !screens.xl;
  const tree = useCadTreeState();
  const { query: erpSearch } = useKBar();
  const [treeOpen, setTreeOpen] = useState(true), [propertiesOpen, setPropertiesOpen] = useState(true), [rightTab, setRightTab] = useState<RightTab>('properties');
  const [panel, setPanel] = useState<'parts' | 'properties' | 'issues' | null>(null);
  const [tool, setTool] = useState<CadTool>('select'), [fitRequest, setFitRequest] = useState(0), [palette, setPalette] = useState(false);
  const blocked = () => { if (!state.incomplete) return false; message.warning('Сначала завершите ввод параметра'); return true; };
  const toggleProperties = () => { if (propertiesOpen && blocked()) return; setPropertiesOpen(open => !open); };
  const showRight = (tab: RightTab) => {
    if (tablet) { if (!blocked()) setPanel(tab === 'issues' ? 'issues' : 'properties'); return; }
    setRightTab(tab); setPropertiesOpen(true);
  };
  const toggleTree = () => { if (tablet) setPanel(p => p === 'parts' ? null : 'parts'); else setTreeOpen(open => !open); };
  const openIssue = (groupId: string) => { if (blocked()) return; c.select([groupId]); if (tablet) setPanel('properties'); else showRight('properties'); };
  const newVariantAllowed = can('cad.edit') && !c.busy;
  const commands: CadCommand[] = [
    { id: 'undo', group: 'Правка', label: 'Отменить', keys: 'Ctrl+Z', enabled: c.canUndo, run: c.undo },
    { id: 'redo', group: 'Правка', label: 'Повторить', keys: 'Ctrl+Shift+Z', enabled: c.canRedo, run: c.redo },
    { id: 'layout', group: 'Правка', label: 'Разложить по позициям', keys: 'L', enabled: c.canLayout, run: c.layout, terms: 'раскладка расставить' },
    { id: 'rotate', group: 'Правка', label: 'Повернуть на 90°', keys: 'R', enabled: !readOnly && selected.length > 0, run: c.rotate },
    { id: 'link', group: 'Правка', label: 'Связать перемещение', keys: 'Ctrl+G', enabled: !readOnly && selected.length > 1, run: c.link, terms: 'объединить группа' },
    { id: 'unlink', group: 'Правка', label: 'Разъединить перемещение', keys: 'Ctrl+Shift+G', enabled: !readOnly && selected.length > 0, run: c.unlink },
    { id: 'select-all', group: 'Правка', label: 'Выбрать все детали', keys: 'Ctrl+A', enabled: draft.groups.length > 0, run: () => c.select(draft.groups.map(g => g.id)) },
    { id: 'add', group: 'Правка', label: 'Добавить детали из заказов', enabled: !readOnly, run: () => c.setImportOpen(true), terms: 'импорт' },
    { id: 'remove', group: 'Правка', label: 'Убрать выбранные из варианта', enabled: !readOnly && selected.length > 0, run: c.removeSelected, terms: 'удалить' },
    { id: 'tool-select', group: 'Инструменты', label: 'Выбор', keys: 'V', enabled: true, run: () => setTool('select') },
    { id: 'tool-pan', group: 'Инструменты', label: 'Панорама', keys: 'H', enabled: true, run: () => setTool('pan'), terms: 'рука' },
    { id: 'tool-measure', group: 'Инструменты', label: 'Измерить', keys: 'M', enabled: true, run: () => setTool('measure'), terms: 'линейка расстояние' },
    { id: 'fit', group: 'Инструменты', label: 'Показать весь комплект', keys: 'F', enabled: draft.groups.length > 0, run: () => setFitRequest(n => n + 1), terms: 'масштаб вписать' },
    { id: 'trajectories', group: 'Вид', label: `Траектории: ${c.trajectories ? 'скрыть' : 'показать'}`, enabled: true, run: () => c.setTrajectories(v => !v) },
    { id: 'material', group: 'Вид', label: `Материал: ${c.materialView ? 'скрыть' : 'показать'}`, enabled: true, run: () => c.setMaterialView(v => !v) },
    { id: 'mode', group: 'Вид', label: c.advanced ? 'Режим менеджера' : 'Режим технолога (расширенный)', enabled: !state.incomplete, run: () => c.setAdvanced(v => !v), terms: 'расширенный режим' },
    { id: 'tree', group: 'Вид', label: 'Панель «Состав»', enabled: true, run: toggleTree, terms: 'детали список' },
    { id: 'properties', group: 'Вид', label: 'Панель «Свойства»', enabled: true, run: () => showRight('properties') },
    { id: 'issues', group: 'Вид', label: `Проверки${issues.length ? ` (${issues.length})` : ''}`, enabled: true, run: () => showRight('issues'), terms: 'ошибки' },
    { id: 'export', group: 'Вариант', label: 'Скачать фрезеровки', enabled: c.canExport, run: () => c.setExportOpen(true), terms: 'выгрузка zip dxf svg' },
    { id: 'new-variant', group: 'Вариант', label: 'Новый вариант', enabled: newVariantAllowed, run: () => c.startClone('clone') },
    { id: 'refresh-variant', group: 'Вариант', label: 'Новый вариант из актуальных данных', enabled: can('cad.edit'), run: () => c.startClone('refresh') },
    { id: 'retry-save', group: 'Вариант', label: 'Повторить сохранение', enabled: state.status === 'error' && !c.busy, run: c.retrySave },
    ...variants.filter(v => v.id !== base.id).map(v => ({ id: `variant:${v.id}`, group: 'Вариант', label: `Открыть вариант ${v.name}`, enabled: !c.busy, run: () => c.activate(v.id) })),
    { id: 'erp-search', group: 'Настройки', label: 'Общий поиск ERP', enabled: true, run: () => erpSearch.toggle(), terms: 'kbar меню разделы' },
    ...(can('references.manage') ? [{ id: 'mapping', group: 'Настройки', label: 'Соответствия типов фрезеровок', enabled: true, run: onMapping }] : []),
  ];
  const command = (id: string) => commands.find(cmd => cmd.id === id)!;
  const paletteBlocked = palette || c.exportOpen || c.importOpen || c.clone !== null;
  // Ctrl+K belongs to the global ERP search (Refine KBar) elsewhere. On the active CAD tab the capture
  // listener runs first and keeps it from KBar; KBar stays reachable as the palette's «Общий поиск ERP».
  useEffect(() => {
    if (!props.active) return;
    const open = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'k') return;
      e.preventDefault(); e.stopPropagation();
      if (!paletteBlocked) setPalette(true);
    };
    window.addEventListener('keydown', open, true); return () => window.removeEventListener('keydown', open, true);
  }, [props.active, paletteBlocked]);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.defaultPrevented || isTextTarget(e.target)) return;
    const cmd = findShortcut(commands, e);
    if (cmd) { e.preventDefault(); if (cmd.enabled) cmd.run(); }
  };
  const tip = (cmd: CadCommand) => cmd.keys ? `${cmd.label} (${cmd.keys})` : cmd.label;
  const cmdButton = (id: string, text: string, ariaLabel?: string) => {
    const cmd = command(id);
    return <Tooltip title={tip(cmd)}><Button aria-label={ariaLabel} disabled={!cmd.enabled} onClick={cmd.run}>{text}</Button></Tooltip>;
  };
  const saveText = base.kind === 'original' ? 'Оригинал · только просмотр' : state.incomplete ? 'Завершите ввод' : ({ saved: 'Все изменения сохранены', dirty: 'Есть изменения', saving: 'Сохраняем…', error: 'Не удалось сохранить', conflict: 'Конфликт версий' })[state.status];
  const partsTitle = `Состав (${draft.groups.length})`;
  const rightBody = <>
    <Segmented className="cad-right-tabs" block size="small" value={rightTab} onChange={value => setRightTab(value as RightTab)}
      options={[{ value: 'properties', label: 'Свойства' }, { value: 'issues', label: `Проверки${issues.length ? ` ${issues.length}` : ''}` }]} />
    {/* Both stay mounted: a half-typed parameter must survive a look at the issue list. */}
    <div hidden={rightTab !== 'properties'}><CadInspector c={c} /></div>
    <div hidden={rightTab !== 'issues'}><CadIssueList c={c} onOpen={openIssue} /></div>
  </>;
  return <div className="cad-workbench" onKeyDown={onKeyDown}>
    <div className="cad-topbar">
      {orderPicker}
      <Tabs className="cad-variant-tabs" activeKey={base.id} onChange={c.activate} items={variants.map(v => ({ key: v.id, label: `${v.kind === 'original' ? '🔒 ' : ''}${v.name}${v.id === base.id && c.dirty ? ' •' : ''}` }))} />
      <Tooltip title="Новый вариант"><Button aria-label="Новый вариант" icon={<PlusOutlined />} disabled={!newVariantAllowed} onClick={() => c.startClone('clone')} /></Tooltip>
      <span className="cad-topbar-end" />
      <Tooltip title="Все команды и поиск заказа (Ctrl+K)"><Button className="cad-palette-button" icon={<SearchOutlined />} onClick={() => setPalette(true)}>Команды <kbd>Ctrl+K</kbd></Button></Tooltip>
      <Tooltip title="Технолог видит технологические параметры, траектории и данные расчёта"><Segmented aria-label="Режим редактора" size="small" disabled={state.incomplete} value={c.advanced ? 'tech' : 'manager'} onChange={value => c.setAdvanced(value === 'tech')}
        options={[{ value: 'manager', label: 'Менеджер' }, { value: 'tech', label: 'Технолог' }]} /></Tooltip>
      <Button type="primary" disabled={!c.canExport} onClick={() => c.setExportOpen(true)}>Скачать фрезеровки</Button>
    </div>
    <div className="cad-editor-toolbar" role="toolbar" aria-label="Команды редактора">
      {tablet && <><Button aria-expanded={panel === 'parts'} onClick={() => setPanel('parts')}>{partsTitle}</Button><Button aria-expanded={panel === 'properties'} onClick={() => setPanel('properties')}>Свойства</Button><span className="cad-toolbar-sep" /></>}
      {cmdButton('undo', '↶', 'Отменить последнее изменение')}{cmdButton('redo', '↷', 'Повторить изменение')}
      <span className="cad-toolbar-sep" />
      {cmdButton('layout', 'Разложить по позициям')}{cmdButton('rotate', 'Повернуть')}{cmdButton('link', 'Связать')}{cmdButton('unlink', 'Разъединить')}
      <span className="cad-toolbar-sep" />
      <Checkbox checked={c.trajectories} onChange={e => c.setTrajectories(e.target.checked)}>Траектории</Checkbox><Checkbox checked={c.materialView} onChange={e => c.setMaterialView(e.target.checked)}>Материал</Checkbox>
      <span className="cad-topbar-end" />
      <span className="cad-hint">{c.preview.pending ? 'Обновляем предпросмотр…' : 'Вид детали · 2D'}</span>
      <Button aria-expanded={tablet ? panel === 'issues' : propertiesOpen && rightTab === 'issues'} danger={issues.length > 0} onClick={() => showRight('issues')}>Проверки{issues.length ? ` (${issues.length})` : ''}</Button>
      <Dropdown trigger={['click']} overlayClassName="cad-compact" menu={{ items: [
        { key: 'add', label: 'Добавить детали из заказов', disabled: readOnly },
        { key: 'refresh', label: 'Новый вариант из актуальных данных', disabled: !can('cad.edit') },
        ...(can('references.manage') ? [{ key: 'mapping', label: 'Соответствия типов фрезеровок' }] : []),
      ], onClick: ({ key }) => { if (key === 'add') c.setImportOpen(true); if (key === 'refresh') c.startClone('refresh'); if (key === 'mapping') onMapping(); } }}>
        <Button aria-label="Ещё команды" icon={<EllipsisOutlined />} />
      </Dropdown>
    </div>
    <div className="cad-editor-layout">
      {!tablet && <CadSidePanel side="left" kind="parts" title={partsTitle} open={treeOpen} onToggle={() => setTreeOpen(open => !open)}><CadCompositionTree c={c} tree={tree} open={treeOpen} /></CadSidePanel>}
      <div className="cad-canvas-area">
        <CadDocumentAlerts c={c} />
        {c.preview.error && <Alert type="warning" message={c.preview.error} />}
        {c.expansion.error ? <Alert type="error" message={c.expansion.error} /> : props.active ? <CadCanvas documentId={base.id} groups={draft.groups} sources={draft.sources} job={c.preview.scene} readOnly={readOnly} selected={selected} onSelect={c.select} onChange={groups => c.edit({ ...draft, groups }, true)} hiddenLayers={c.hidden} expanded={false} finished={c.materialView} trajectories={c.trajectories} changed={c.changed} ordinals={c.ordinals} dimension={c.dimension} onVisible={c.setVisible} onViewportSize={c.viewportChanged} fitOnOpen={c.automaticLayout} fitKey={`${c.layoutRevision}:${fitRequest}`} layoutAspect={c.initialAspect} tool={tool} onToolChange={setTool} /> : <div className="cad-canvas-shell" />}
      </div>
      {!tablet && <CadSidePanel side="right" title="Свойства" open={propertiesOpen} onToggle={toggleProperties}>{rightBody}</CadSidePanel>}
    </div>
    <footer className="cad-document-footer cad-statusbar">
      <div role="status" aria-live="polite" className={`cad-save-state is-${base.kind === 'original' ? 'locked' : state.incomplete ? 'incomplete' : state.status}`}>{saveText}</div>
      <span>Выбрано {selected.length} из {draft.groups.length}</span>
      {c.preview.pending && <span>Обновляем предпросмотр…</span>}
      <span className="cad-topbar-end" />
      <button type="button" className={`cad-status-issues${issues.length ? ' has-issues' : ''}`} onClick={() => showRight('issues')}>{issues.length ? `Ошибок: ${issues.length}` : 'Ошибок нет'}</button>
    </footer>
    <Drawer rootClassName="cad-compact" open={panel !== null} placement="right" width={Math.min(420, window.innerWidth)} title={panel === 'parts' ? 'Состав' : panel === 'properties' ? 'Свойства детали' : 'Что нужно проверить'} afterOpenChange={open => { if (open && panel === 'parts') tree.restoreScroll(); }} onClose={() => { if (!blocked()) setPanel(null); }}>
      {panel === 'parts' ? <CadCompositionTree c={c} tree={tree} open rowHeight={40} /> : panel === 'properties' ? <CadInspector c={c} /> : <CadIssueList c={c} onOpen={openIssue} />}
    </Drawer>
    <Modal className="cad-compact" open={c.clone !== null} title={c.clone === 'fork' ? 'Сохранить мои изменения отдельно' : c.clone === 'refresh' ? 'Вариант из актуальных данных' : 'Новый рабочий вариант'} onCancel={() => c.setClone(null)} confirmLoading={c.busy} okButtonProps={{ disabled: !c.name.trim() }} onOk={c.submitClone}>
      <Input aria-label="Имя нового варианта" value={c.name} maxLength={100} onChange={e => c.setName(e.target.value)} /><p>Оригинал и предыдущие варианты останутся неизменными.</p></Modal>
    <CadImportDialog open={c.importOpen} draft={draft} onChange={c.edit} onClose={() => c.setImportOpen(false)} />
    <CadExportDialog open={c.exportOpen} flush={c.exportFlush} onClose={() => c.setExportOpen(false)} />
    <CadCommandPalette open={palette} commands={commands} onClose={() => setPalette(false)} onOpenOrder={onOpenOrder} currentOrderId={props.orderId} />
  </div>;
}

/** Save/conflict/source banners float over the canvas instead of pushing it down. */
function CadDocumentAlerts({ c }: { c: CadEditorController }) {
  const { state, source } = c;
  return <div className="cad-canvas-alerts">
    {state.status === 'error' && <Alert type="error" message="Изменения остались в этой вкладке" description="Не закрывайте её. Повторное сохранение не создаст дубль." action={<Button loading={c.busy} onClick={c.retrySave}>Повторить сохранение</Button>} />}
    {state.status === 'conflict' && <Alert type="warning" message="Коллега уже изменил этот вариант" description="Ваши изменения сохранены локально. Выберите отдельный вариант или загрузите изменения коллеги." action={<Space><Button onClick={() => c.startClone('fork')}>Сохранить мои в новый вариант</Button><Button onClick={c.loadColleague}>Загрузить вариант коллеги</Button></Space>} />}
    {source.data?.some(s => s.stale) && <Alert type="warning" message="Исходные заказы изменились. Этот вариант сохранён без изменений." action={<Button disabled={!can('cad.edit')} onClick={() => c.startClone('refresh')}>Новый вариант из актуальных данных</Button>} />}
    {source.isError && <Alert type="warning" message="Актуальность заказов пока не проверена" />}
  </div>;
}
