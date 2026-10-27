import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Modal, message } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { CadGroup, CadVariant } from '@shared/cad-workspace';
import { validateComposition } from '@shared/cad-workspace';
import { cadApi } from '../../api/cadApi';
import { can } from '../../utils/permissions';
import { useTabStore } from '../../stores/tabStore';
import { saveCadTabs } from './cadViewState';
import { useCadRecipeCatalog } from './useCadRecipeCatalog';
import { CadAutosave, type CadDraft } from './cadAutosave';
import { useCadPreview } from './useCadPreview';
import { expandInstances, differsFromPosition } from './cadInstances';
import { isInitialPositionLayout, layoutPositionBlocks } from './cadPositionLayout';

export interface CadEditorControllerProps { variant: CadVariant; variants: CadVariant[]; orderId: number; active: boolean; tabKey: string;
  registerLeave: (fn: () => Promise<unknown>) => void; onActivate: (id: string) => void }
export interface CadIssue { groupId?: string; code: string; message: string }
export type CadCloneMode = 'clone' | 'refresh' | 'fork';

/** Document state and commands of one CAD variant. Layout components only read it and call its actions. */
export function useCadEditorController({ variant, variants, orderId, active, tabKey, registerLeave, onActivate }: CadEditorControllerProps) {
  const queryClient = useQueryClient();
  const [queue] = useState(() => new CadAutosave(variant, cadApi.save));
  const state = useSyncExternalStore(queue.subscribe, queue.snapshot);
  const { base } = state;
  const [initialAspect, setInitialAspect] = useState<number | null>(null);
  const viewportAspect = useRef(1.6);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const viewportChanged = useCallback((width: number, height: number) => {
    if (width <= 100 || height <= 100) return;
    const aspect = (width - 64) / (height - 64);
    viewportAspect.current = aspect;
    setInitialAspect(old => old ?? aspect);
  }, []);
  const automaticLayout = state.draft.groups === base.groups && isInitialPositionLayout(base.groups, base.sources, base.version);
  const instanceIds = useRef(new Map<string, string>());
  const copyId = useCallback((id: string, index: number) => {
    const key = `${id}:${index}`;
    if (!instanceIds.current.has(key)) instanceIds.current.set(key, crypto.randomUUID());
    return instanceIds.current.get(key)!;
  }, []);
  const expansion = useMemo(() => {
    try {
      const groups = expandInstances(state.draft.groups, state.draft.sources, copyId);
      return { groups: automaticLayout ? layoutPositionBlocks(groups, state.draft.sources, initialAspect ?? 1.6) : groups, error: null };
    }
    catch (error) { return { groups: state.draft.groups, error: error instanceof Error ? error.message : 'Некорректное количество экземпляров' }; }
  }, [state.draft, copyId, automaticLayout, initialAspect]);
  const draft = useMemo(() => ({ ...state.draft, groups: expansion.groups }), [state.draft, expansion.groups]);
  const [selected, setSelected] = useState<string[]>([]), [visible, setVisible] = useState<string[]>(variant.groups.slice(0, 20).map(g => g.id));
  const [advanced, setAdvanced] = useState(false), [trajectories, setTrajectories] = useState(true), [materialView, setMaterialView] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set()), [dimension, setDimension] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false), [exportOpen, setExportOpen] = useState(false);
  const [clone, setClone] = useState<CadCloneMode | null>(null), [name, setName] = useState(''), [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<CadDraft[]>([]), [redo, setRedo] = useState<CadDraft[]>([]);
  const invalid = useRef(new Set<string>()), forkKey = useRef(crypto.randomUUID());
  const readOnly = base.kind === 'original' || !can('cad.edit') || Boolean(expansion.error), technical = can('cad.technology');
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
  const issues: CadIssue[] = useMemo(() => [
    ...validateComposition(draft.groups, draft.sources),
    ...draft.groups.filter(g => !g.recipe).map(g => ({ groupId: g.id, code: 'RECIPE_MISSING', message: 'Не выбрана фрезеровка. Выберите одобренный вариант.' })),
    ...preview.scene.items.flatMap(i => (i.result?.errors ?? []).map(e => ({ groupId: i.part_id, code: e.code, message: e.message ?? 'Параметры не подходят детали. Проверьте настройки фрезеровки.' }))),
  ], [draft, preview.scene.items]);
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); try { await fn(); } catch (e) { message.error(e instanceof Error ? e.message : 'Не удалось выполнить действие'); } finally { setBusy(false); } };
  const edit = (next: CadDraft, immediate = false) => { if (readOnly) return; const groups = expandInstances(next.groups, next.sources, copyId); setHistory(h => [...h.slice(-49), draft]); setRedo([]); queue.edit({ ...next, groups }, immediate); };
  const changeGroup = (patch: Partial<CadGroup>) => { if (group) edit({ ...draft, groups: draft.groups.map(g => g.id === group.id ? { ...g, ...patch } : g) }); };
  const validity = useCallback((key: string, valid: boolean) => { if (valid) invalid.current.delete(key); else invalid.current.add(key); queue.setIncomplete(invalid.current.size > 0); }, [queue]);
  const select = (ids: string[]) => { if (state.incomplete) { message.warning('Завершите ввод параметра перед сменой детали'); return false; } setSelected(ids); setDimension(null); return true; };
  const activate = (id: string) => void act(async () => { await flush(); onActivate(id); });
  const recipeName = (g: CadGroup) => catalog.data?.recipes.find(r => r.code === g.recipe?.code && r.version === g.recipe.version)?.display_name ?? (g.recipe ? 'Сохранённая фрезеровка' : 'Нет фрезеровки');
  const fields = recipe ? Object.entries(recipe.parameter_schema).filter(([, s]) => advanced || s.manager_editable) : [];
  const layers = [...new Set(item?.result?.geometry?.milling.map(p => p.layer) ?? [])];
  const defaultsFor = (g: CadGroup) => catalog.data?.recipes.find(r => r.code === g.recipe?.code && r.version === g.recipe.version)?.defaults ?? {};
  const changed = new Set(draft.groups.filter(g => {
    const p = draft.sources.find(s => s.id === g.sourceSnapshotId)?.parts.find(p => p.detailId === g.detailId);
    return p && differsFromPosition(g.recipe, p.recipe, defaultsFor(g));
  }).map(g => g.id));
  const ordinals = new Map<string, { number: number; total: number }>();
  const totals = new Map<string, number>(), seen = new Map<string, number>();
  for (const g of draft.groups) { const key = `${g.sourceSnapshotId}:${g.detailId}`; totals.set(key, (totals.get(key) ?? 0) + 1); }
  for (const g of draft.groups) { const key = `${g.sourceSnapshotId}:${g.detailId}`; const number = (seen.get(key) ?? 0) + 1; seen.set(key, number); ordinals.set(g.id, { number, total: totals.get(key)! }); }
  const canUndo = !readOnly && history.length > 0 && !state.incomplete, canRedo = !readOnly && redo.length > 0 && !state.incomplete;
  const undo = () => { const prev = history.at(-1); if (prev && canUndo) { setRedo(r => [...r, draft]); setHistory(h => h.slice(0, -1)); queue.edit(prev); } };
  const redoEdit = () => { const next = redo.at(-1); if (next && canRedo) { setHistory(h => [...h, draft]); setRedo(r => r.slice(0, -1)); queue.edit(next); } };
  const canLayout = !readOnly && !state.incomplete && state.status !== 'conflict' && initialAspect !== null;
  const layout = () => {
    if (!canLayout) return;
    try { edit({ ...draft, groups: layoutPositionBlocks(draft.groups, draft.sources, viewportAspect.current) }, true); setLayoutRevision(n => n + 1); }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось разложить детали'); }
  };
  const editSelected = (patch: (g: CadGroup) => CadGroup) => { if (!readOnly && selected.length) edit({ ...draft, groups: draft.groups.map(g => selected.includes(g.id) ? patch(g) : g) }); };
  const link = () => { if (selected.length > 1) { const id = crypto.randomUUID(); editSelected(g => ({ ...g, placementGroupId: id })); } };
  const unlink = () => editSelected(g => ({ ...g, placementGroupId: undefined }));
  const rotate = () => editSelected(g => ({ ...g, rotationDeg: ((g.rotationDeg + 90) % 360 + 360) % 360 }));
  const removeSelected = () => { if (readOnly || !selected.length) return; edit({ ...draft, groups: draft.groups.filter(g => !selected.includes(g.id)) }); setSelected([]); };
  const canExport = can('cad.export') && !expansion.error && !state.incomplete && state.status !== 'conflict';
  const startClone = (mode: CadCloneMode) => {
    if (mode === 'fork') { forkKey.current = crypto.randomUUID(); setName(`${base.name} · мои изменения`); }
    else setName(mode === 'refresh' ? `Актуальный состав ${variants.length}` : `Рабочая ${variants.length}`);
    setClone(mode);
  };
  const submitClone = () => void act(async () => {
    const next = clone === 'fork' ? await cadApi.fork(base, draft.groups, draft.sources.map(s => s.id), name, forkKey.current) : await cadApi.clone((await flush()).id, name, clone === 'refresh');
    await queryClient.invalidateQueries(['cad-workspace', orderId]); useTabStore.getState().setDirty(tabKey, false); setClone(null); onActivate(next.id);
  });
  const loadColleague = () => Modal.confirm({ className: 'cad-compact', title: 'Отбросить мои несохранённые изменения?', content: 'Будет загружен текущий вариант коллеги.', onOk: async () => {
    const current = await cadApi.workspace(orderId); const fresh = current.variants.find(v => v.id === base.id);
    if (fresh) { invalid.current.clear(); queue.reset(fresh); setHistory([]); setRedo([]); await queryClient.invalidateQueries(['cad-workspace', orderId]); }
  } });
  const retrySave = () => void act(async () => { await flush(); });
  const exportFlush = async () => {
    if (expansion.error) throw new Error(expansion.error);
    if (!readOnly && (automaticLayout || state.draft.groups.some(g => g.quantity > 1))) queue.edit(draft, true);
    return flush();
  };
  return {
    state, base, draft, expansion, automaticLayout, initialAspect, layoutRevision, viewportChanged, variants, orderId,
    selected, select, setVisible, advanced, setAdvanced, trajectories, setTrajectories, materialView, setMaterialView,
    hidden, setHidden, dimension, setDimension, importOpen, setImportOpen, exportOpen, setExportOpen,
    clone, setClone, name, setName, busy, readOnly, technical, dirty, catalog, source, preview,
    group, part, recipe, item, issues, edit, changeGroup, validity, activate, recipeName, fields, layers, changed, ordinals,
    canUndo, canRedo, undo, redo: redoEdit, canLayout, layout, link, unlink, rotate, removeSelected, canExport,
    startClone, submitClone, loadColleague, retrySave, exportFlush,
  };
}
export type CadEditorController = ReturnType<typeof useCadEditorController>;
