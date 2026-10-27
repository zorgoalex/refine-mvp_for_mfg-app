import React from 'react';
import { Alert, Button, Checkbox, Select } from 'antd';
import type { JsonValue } from '@shared/cad-workspace';
import { CadParameterField } from './CadParameterField';
import type { CadEditorController } from './useCadEditorController';

export function CadInspector({ c }: { c: CadEditorController }) {
  const { group, part, recipe, item, selected, draft, readOnly, technical, advanced, state, catalog, fields, layers, ordinals, changed } = c;
  return <><div className="cad-panel-title"><h2>{group ? 'Деталь' : selected.length > 1 ? `Выбрано: ${selected.length}` : 'Свойства'}</h2></div>
    {group && part ? <><h3>Позиция {part.detailNumber} · экземпляр {ordinals.get(group.id)?.number}/{ordinals.get(group.id)?.total}</h3><p>{part.widthMm} × {part.heightMm} × {part.thicknessMm ?? '?'} мм<br />{part.material}</p><p className="cad-hint">Заказ {draft.sources.find(s => s.id === group.sourceSnapshotId)?.orderName} · обкат: {part.edgeName || '—'}</p>
      {item?.status !== 'succeeded' && <Alert type="warning" message={item?.status === 'failed' ? 'Фрезеровка не рассчитана' : 'Ожидается предпросмотр'} description="Контур на поле ещё не подтверждает правильность фрезеровки." />}
      {item?.result?.visualization?.quality !== 'exact' && item?.status === 'succeeded' && <Alert type="info" message="Схематичный вид" description="Профиль фрезы отсутствует или не подтверждён. Показаны траектории; точный вид снятого материала недоступен." />}
      <label className="cad-field-label">Фрезеровка<Select popupClassName="cad-compact" aria-label="Фрезеровка детали" disabled={readOnly || state.incomplete} value={group.recipe ? `${group.recipe.code}@${group.recipe.version}` : undefined} placeholder="Выберите фрезеровку" options={catalog.data?.recipes.filter(r => r.manager_ready || technical).map(r => ({ value: `${r.code}@${r.version}`, label: `${r.display_name} · ${r.version}${r.manager_ready ? '' : ' · требует проверки'}` }))} onChange={value => { const r = catalog.data?.recipes.find(r => `${r.code}@${r.version}` === value); if (r) c.changeGroup({ recipe: { code: r.code, version: r.version, parameters: {} } }); }} /></label>
      {changed.has(group.id) && <div className="cad-instance-difference" role="status">⚠ Фрезеровка отличается от общей для позиции.<Button disabled={readOnly || state.incomplete} onClick={() => c.changeGroup({ recipe: structuredClone(part.recipe) })}>Вернуть фрезеровку позиции</Button></div>}
      {fields.map(([key, schema]) => <CadParameterField key={`${group.id}:${recipe!.code}:${recipe!.version}:${key}`} name={key} schema={schema} value={group.recipe && Object.hasOwn(group.recipe.parameters, key) ? group.recipe.parameters[key] : schema.default} disabled={readOnly || !technical && !schema.manager_editable} bounded={!technical || !advanced} tools={recipe!.available_tools} onValidity={c.validity} onFocus={c.setDimension} onChange={(value: JsonValue) => { if (group.recipe) c.changeGroup({ recipe: { ...group.recipe, parameters: { ...group.recipe.parameters, [key]: value } } }); }} />)}
      {!advanced && !fields.length && <p className="cad-hint">Размеры фрезеровки рассчитываются автоматически. Технологические настройки скрыты.</p>}
      <details><summary>Положение на поле</summary>{(['xMm', 'yMm', 'rotationDeg'] as const).map(key => <CadParameterField key={`${group.id}:${key}`} name={key} schema={{ type: 'number', default: 0, label: key === 'xMm' ? 'По горизонтали' : key === 'yMm' ? 'По вертикали' : 'Поворот', unit: key === 'rotationDeg' ? '°' : 'мм', integer: false, nullable: false, manager_editable: true }} value={group[key]} bounded={false} disabled={readOnly} tools={[]} onValidity={c.validity} onFocus={() => c.setDimension(null)} onChange={v => { if (typeof v === 'number') c.changeGroup({ [key]: v }); }} />)}</details>
      {advanced && <details><summary>Траектории и технические данные</summary>{layers.map(layer => <Checkbox key={layer} checked={!c.hidden.has(layer)} onChange={e => c.setHidden(old => { const next = new Set(old); if (e.target.checked) next.delete(layer); else next.add(layer); return next; })}>{layer}</Checkbox>)}{item?.result?.geometry?.milling.map(p => <p key={p.path_id} className="cad-hint">{p.layer} · {p.tool_id} · место {p.slot ?? '—'} · глубина {p.depth_mm ?? '—'} мм</p>)}<code className="cad-hash">{item?.snapshot_hash}</code></details>}
    </> : <p className="cad-hint">{selected.length > 1 ? 'Настройки фрезеровки доступны для одной детали. Выбранные детали можно перемещать вместе.' : 'Выберите деталь на поле или в составе.'}</p>}
    {selected.length > 1 && <Button disabled={readOnly} onClick={c.link}>Объединить перемещение</Button>}
    {selected.length > 0 && <Button disabled={readOnly} onClick={c.unlink}>Разъединить перемещение</Button>}
  </>;
}

/** Issue list; «Перейти к детали» hands the instance to the properties view. */
export function CadIssueList({ c, onOpen }: { c: CadEditorController; onOpen: (groupId: string) => void }) {
  const { issues, advanced } = c;
  return <><div className="cad-panel-title"><h2>Проверки {issues.length > 0 && <span>{issues.length}</span>}</h2></div>
    {!issues.length && <Alert type="info" message="Ошибок предпросмотра не обнаружено" description="Полная проверка всех деталей и одобрений выполняется перед скачиванием." />}
    {issues.map((i, n) => <div key={n} className="cad-export-issue"><p>{i.message}</p>{advanced && <code>{i.code}</code>}{i.groupId && <Button onClick={() => onOpen(i.groupId!)}>Перейти к детали</Button>}</div>)}
    <p className="cad-hint">Пунктирный контур означает, что фрезеровка ещё не рассчитана. Схематичный вид не заменяет проверку в CAM.</p></>;
}
