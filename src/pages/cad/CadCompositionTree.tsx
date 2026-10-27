import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Input } from 'antd';
import { CaretDownOutlined, CaretRightOutlined } from '@ant-design/icons';
import type { CadEditorController } from './useCadEditorController';
import { cadPathData } from './CadCanvas';
import { buildCompositionRows, type CadTreeFilter } from './cadCompositionRows';


/** Lives in the document, not the tree: the tablet drawer unmounts the tree, its search and scroll must survive. */
export function useCadTreeState() {
  const [search, setSearch] = useState(''), [filter, setFilter] = useState<CadTreeFilter>('all');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set()), [multiSelect, setMultiSelect] = useState(false);
  const scroll = useRef(0), listNode = useRef<HTMLDivElement | null>(null);
  /** A hidden or freshly mounted list starts at 0; put it back where the user left it. */
  const restoreScroll = () => { if (listNode.current) listNode.current.scrollTop = scroll.current; };
  return { search, setSearch, filter, setFilter, collapsed, setCollapsed, multiSelect, setMultiSelect, scroll, listNode, restoreScroll };
}
export type CadTreeState = ReturnType<typeof useCadTreeState>;

/** `rowHeight` grows on tablets: rows are touch targets there. */
export function CadCompositionTree({ c, tree, open, rowHeight: ROW = 30 }: { c: CadEditorController; tree: CadTreeState; open: boolean; rowHeight?: number }) {
  const { draft, selected, readOnly, preview, issues, changed, ordinals } = c;
  const { listNode } = tree;
  const [scroll, setScroll] = useState(tree.scroll.current), [height, setHeight] = useState(600);
  const issueIds = useMemo(() => new Set(issues.flatMap(i => i.groupId ? [i.groupId] : [])), [issues]);
  const rows = useMemo(() => buildCompositionRows({ groups: draft.groups, sources: draft.sources, search: tree.search, filter: tree.filter,
    collapsed: tree.collapsed, issueIds, changedIds: changed, recipeName: c.recipeName }), [draft, tree.search, tree.filter, tree.collapsed, issueIds, changed, c.recipeName]);
  const counts = useMemo(() => ({ issues: draft.groups.filter(g => issueIds.has(g.id)).length, changed: changed.size, unassigned: draft.groups.filter(g => !g.recipe).length }), [draft.groups, issueIds, changed]);
  const rendered = useMemo(() => new Map(preview.scene.items.map(i => [i.part_id, i])), [preview.scene.items]);
  // A hidden (display:none) list loses scrollTop; restore it whenever the tree becomes visible again.
  useEffect(() => { if (open) tree.restoreScroll(); }, [open]);
  useEffect(() => {
    const node = listNode.current; if (!node) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height || 600));
    observer.observe(node); return () => observer.disconnect();
  }, []);
  const resetScroll = () => { tree.scroll.current = 0; setScroll(0); if (listNode.current) listNode.current.scrollTop = 0; };
  const pick = (ids: string[], additive: boolean) => {
    if (!additive) { c.select(ids); return; }
    const all = ids.every(id => selected.includes(id));
    c.select(all ? selected.filter(id => !ids.includes(id)) : [...new Set([...selected, ...ids])]);
  };
  const toggle = (key: string) => tree.setCollapsed(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const first = Math.max(0, Math.floor(scroll / ROW) - 4), visibleRows = rows.slice(first, first + Math.ceil(height / ROW) + 8);
  const filters: Array<[CadTreeFilter, string, number | null]> = [['all', 'Все', null], ['issues', 'Ошибки', counts.issues], ['changed', 'Изменены', counts.changed], ['unassigned', 'Без фрезеровки', counts.unassigned]];
  return <>
    <div className="cad-panel-title"><h2>Состав <span>{draft.groups.length}</span></h2><Button disabled={readOnly} onClick={() => c.setImportOpen(true)}>Добавить</Button></div>
    <Input.Search aria-label="Найти деталь" placeholder="Позиция или фрезеровка" value={tree.search} onChange={e => { tree.setSearch(e.target.value); resetScroll(); }} />
    <div className="cad-tree-filters" role="group" aria-label="Фильтр состава">{filters.map(([value, label, count]) => <button key={value} type="button" aria-pressed={tree.filter === value}
      className={`cad-tree-filter${tree.filter === value ? ' is-active' : ''}${value === 'issues' && count ? ' is-danger' : ''}`} onClick={() => { tree.setFilter(value); resetScroll(); }}>{label}{count ? ` ${count}` : ''}</button>)}</div>
    <Checkbox checked={tree.multiSelect} onChange={e => tree.setMultiSelect(e.target.checked)}>Выбрать несколько</Checkbox>
    <div className="cad-part-list" ref={listNode} aria-label="Состав варианта" onScroll={e => { tree.scroll.current = e.currentTarget.scrollTop; setScroll(e.currentTarget.scrollTop); }}>
      {!rows.length && <p className="cad-hint">Нет деталей по этому условию.</p>}
      <div style={{ height: rows.length * ROW, position: 'relative' }}>{visibleRows.map((row, i) => {
        const top = (first + i) * ROW;
        if (row.kind === 'position') {
          const p = row.part, chosen = row.ids.filter(id => selected.includes(id)).length;
          const label = `Позиция ${p?.detailNumber ?? '?'}`;
          return <div key={`p:${row.key}`} className={`cad-tree-position${chosen ? chosen === row.ids.length ? ' selected' : ' partial' : ''}`} style={{ top, height: ROW }}>
            <button type="button" className="cad-tree-caret" aria-expanded={!row.collapsed} aria-label={`${row.collapsed ? 'Раскрыть' : 'Свернуть'}: ${label}`} onClick={() => toggle(row.key)}>{row.collapsed ? <CaretRightOutlined /> : <CaretDownOutlined />}</button>
            <button type="button" className="cad-tree-position-label" aria-pressed={chosen === row.ids.length} aria-label={`Выбрать все экземпляры: ${label}`} title={`Выбрать все экземпляры: ${label}`} onClick={e => pick(row.ids, tree.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey)}>
              <strong>{label}</strong><small>{p?.widthMm} × {p?.heightMm} · {row.ids.length === row.total ? `${row.total} шт` : `${row.ids.length} из ${row.total}`}{draft.sources.length > 1 ? ` · ${row.orderName}` : ''}</small>
            </button></div>;
        }
        const g = row.group, p = row.part, drawn = rendered.get(g.id), isSelected = selected.includes(g.id);
        const ordinal = ordinals.get(g.id), state = issueIds.has(g.id) ? 'error' : drawn?.status !== 'succeeded' ? 'pending' : null;
        return <button key={g.id} type="button" aria-pressed={isSelected} style={{ top, height: ROW }} className={`cad-part-card ${isSelected ? 'selected' : ''}`}
          title={`Позиция ${p?.detailNumber} · экземпляр ${ordinal?.number}/${ordinal?.total}`}
          onClick={e => pick([g.id], tree.multiSelect || e.ctrlKey || e.metaKey || e.shiftKey)}>
          <svg width="14" height="20" viewBox={`-8 -8 ${(p?.widthMm ?? 100) + 16} ${(p?.heightMm ?? 100) + 16}`} aria-hidden="true"><g transform={`translate(0 ${p?.heightMm ?? 100}) scale(1 -1)`}><rect width={p?.widthMm ?? 100} height={p?.heightMm ?? 100} fill="#f4e8ce" stroke="#87919c" strokeWidth={10} />{drawn?.result?.geometry?.milling.slice(0, 40).map(path => <path key={path.path_id} d={cadPathData(path)} fill="none" stroke="#9c7641" strokeWidth={8} />)}</g></svg>
          <span className="cad-part-card-text"><strong>{ordinal?.number}/{ordinal?.total}</strong> <small>{c.recipeName(g)}</small></span>
          {changed.has(g.id) && <span className="cad-instance-warning" title="Фрезеровка отличается от позиции" aria-label="Фрезеровка отличается от позиции">⚠</span>}
          {state && <span className={`cad-tree-badge is-${state}`}>{state === 'error' ? 'ошибка' : 'расчёт'}</span>}
        </button>;
      })}</div>
    </div>
    <Button danger disabled={readOnly || !selected.length} onClick={c.removeSelected}>Убрать выбранные из варианта</Button><p className="cad-hint">Исходные заказы не изменяются.</p>
  </>;
}
