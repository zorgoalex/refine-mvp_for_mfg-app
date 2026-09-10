import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Group, Rect, Path, Text, Line } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { CadGroup, CadSourceSnapshot } from '@shared/cad-workspace';
import type { CadJob, CadPath } from '@shared/cad-api';
import { Button, InputNumber, Space } from 'antd';
import { loadCamera, saveCamera } from './cadViewState';
import { placedBounds, regionPath } from './cadCanvasGeometry';

export function cadPathData(path: CadPath): string {
  if (path.segments.length) return path.segments.map((s, i) => `${i ? '' : `M${s.start.x},${s.start.y} `}${s.segment_type === 'arc' ? `A${s.radius_mm},${s.radius_mm} 0 ${s.large_arc ? 1 : 0} ${s.clockwise ? 0 : 1} ` : 'L'}${s.end.x},${s.end.y}`).join(' ') + (path.closed ? ' Z' : '');
  return path.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + (path.closed ? ' Z' : '');
}
interface Props {
  documentId: string;
  groups: CadGroup[]; sources: CadSourceSnapshot[]; job: CadJob | null; readOnly: boolean; selected: string[];
  onSelect: (ids: string[]) => void; onChange: (groups: CadGroup[]) => void; hiddenLayers: Set<string>; expanded: boolean;
  finished?: boolean; trajectories?: boolean; dimension?: string | null; onVisible?: (ids: string[]) => void;
}
export function CadCanvas({ documentId, groups, sources, job, readOnly, selected, onSelect, onChange, hiddenLayers, expanded,
  finished = false, trajectories = true, dimension, onVisible }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 650 });
  const [camera, setCamera] = useState(() => loadCamera(documentId) ?? { x: 30, y: 620, zoom: .25 });
  useEffect(() => { const timer = setTimeout(() => saveCamera(documentId, camera), 200); return () => clearTimeout(timer); }, [documentId, camera]);
  const [tool, setTool] = useState<'select' | 'pan' | 'measure'>('select');
  const pan = tool === 'pan', measure = tool === 'measure';
  const [points, setPoints] = useState<Array<{ x: number; y: number }>>([]);
  const [measureCursor, setMeasureCursor] = useState({ x: 0, y: 0 });
  const markPoint = (point: { x: number; y: number }) => setPoints(old => [...(old.length === 2 ? [] : old), point]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: Math.max(100, entry.contentRect.height) }));
    if (root.current) observer.observe(root.current); return () => observer.disconnect();
  }, []);
  const rendered = useMemo(() => new Map(job?.items.map(i => [i.part_id, i]) ?? []), [job]);
  const parts = useMemo(() => new Map(sources.flatMap(s => s.parts.map(p => [`${s.id}:${p.detailId}`, p] as const))), [sources]);
  const bounds = useMemo(() => new Map(groups.flatMap(g => {
    const p = parts.get(`${g.sourceSnapshotId}:${g.detailId}`);
    return p ? [[g.id, placedBounds(g, p, expanded && selected.includes(g.id) ? Math.min(g.quantity, 200) : 1)] as const] : [];
  })), [groups, parts, expanded, selected]);
  const visible = groups.filter(g => { const b = bounds.get(g.id); return b && b.maxX >= -camera.x / camera.zoom && b.minX <= (size.width - camera.x) / camera.zoom && b.maxY >= (camera.y - size.height) / camera.zoom && b.minY <= camera.y / camera.zoom; }).map(g => g.id);
  const visibleKey = visible.join(',');
  useEffect(() => { onVisible?.(visible); }, [visibleKey, onVisible]);
  const fit = () => {
    const values = [...bounds.values()]; if (!values.length) return;
    const minX = Math.min(...values.map(b => b.minX)), maxX = Math.max(...values.map(b => b.maxX));
    const minY = Math.min(...values.map(b => b.minY)), maxY = Math.max(...values.map(b => b.maxY));
    const zoom = Math.max(.001, Math.min(8, (size.width - 64) / Math.max(1, maxX - minX), (size.height - 64) / Math.max(1, maxY - minY)));
    setCamera({ zoom, x: (size.width - (maxX + minX) * zoom) / 2, y: (size.height + (maxY + minY) * zoom) / 2 });
  };
  const autoFit = useRef(!loadCamera(documentId));
  useEffect(() => { if (autoFit.current && groups.length && size.width > 100) fit(); }, [groups.length, size.width, size.height, documentId]);
  const zoomAt = (x: number, y: number, factor: number) => { autoFit.current = false; setCamera(c => { const z = Math.max(.001, Math.min(8, c.zoom * factor)); return { zoom: z, x: x - (x - c.x) / c.zoom * z, y: y - (y - c.y) / c.zoom * z }; }); };
  const choose = (g: CadGroup, multi: boolean) => {
    const ids = g.placementGroupId ? groups.filter(v => v.placementGroupId === g.placementGroupId).map(v => v.id) : [g.id];
    onSelect(multi ? [...new Set([...selected, ...ids])] : ids);
  };
  const click = (event: KonvaEventObject<MouseEvent | TouchEvent>) => {
    const stage = event.target.getStage(); const p = stage?.getPointerPosition();
    if (measure && p) markPoint({ x: (p.x - camera.x) / camera.zoom, y: (camera.y - p.y) / camera.zoom });
    else if (tool === 'select' && event.target === stage) onSelect([]);
  };
  return <div className="cad-canvas-shell">
    <Space className="cad-canvas-tools" wrap>
      <Button onClick={() => zoomAt(size.width / 2, size.height / 2, 1.25)} aria-label="Увеличить">＋</Button>
      <Button onClick={() => zoomAt(size.width / 2, size.height / 2, .8)} aria-label="Уменьшить">−</Button>
      <Button onClick={fit} title="F">Весь комплект</Button>
      <Button aria-pressed={tool === 'select'} type={tool === 'select' ? 'primary' : 'default'} onClick={() => setTool('select')} title="V">Выбор</Button>
      <Button aria-pressed={pan} type={pan ? 'primary' : 'default'} onClick={() => setTool('pan')} title="H">Панорама</Button>
      <Button aria-pressed={measure} type={measure ? 'primary' : 'default'} onClick={() => { setTool('measure'); setPoints([]); }} title="M">Измерить</Button>
      <span>{Math.round(camera.zoom * 100)}% · мм · Y ↑</span>
    </Space>
    {measure && <Space className="cad-canvas-tools" wrap>
      <span>Точка {points.length === 1 ? 2 : 1}, мм:</span>
      <InputNumber aria-label="Координата X измерения" value={measureCursor.x} onChange={x => { if (typeof x === 'number' && Number.isFinite(x)) setMeasureCursor(p => ({ ...p, x })); }} />
      <InputNumber aria-label="Координата Y измерения" value={measureCursor.y} onChange={y => { if (typeof y === 'number' && Number.isFinite(y)) setMeasureCursor(p => ({ ...p, y })); }} />
      <Button onClick={() => markPoint(measureCursor)}>Указать точку</Button>
      {points.length === 2 && <output aria-live="polite">Расстояние: {Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y).toFixed(2)} мм</output>}
    </Space>}
    <div ref={root} className="cad-canvas" role="application" tabIndex={0} aria-label="Поле CAD. V выбор, H панорама, M измерить, F весь комплект. Стрелки перемещают выбранные детали."
      onKeyDown={e => {
        const key = e.key.toLowerCase();
        if (['v', 'h', 'm', 'f', '+', '-', '=', 'escape'].includes(key)) { e.preventDefault();
          if (key === 'v' || key === 'escape') { setTool('select'); setPoints([]); } if (key === 'h') setTool('pan'); if (key === 'm') { setTool('measure'); setPoints([]); }
          if (key === 'f') fit(); if (key === '+' || key === '=') zoomAt(size.width / 2, size.height / 2, 1.25); if (key === '-') zoomAt(size.width / 2, size.height / 2, .8);
        }
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const n = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -n : e.key === 'ArrowRight' ? n : 0, dy = e.key === 'ArrowDown' ? -n : e.key === 'ArrowUp' ? n : 0;
          if (pan) { autoFit.current = false; setCamera(c => ({ ...c, x: c.x - dx * 10, y: c.y + dy * 10 })); }
          else if (measure) setMeasureCursor(p => ({ x: p.x + dx, y: p.y + dy }));
          else if (!readOnly && tool === 'select') onChange(groups.map(g => selected.includes(g.id) ? { ...g, xMm: g.xMm + dx, yMm: g.yMm + dy } : g));
        }
        if (measure && e.key === 'Enter') { e.preventDefault(); markPoint(measureCursor); }
      }}>
      <Stage width={size.width} height={size.height} x={camera.x} y={camera.y} scaleX={camera.zoom} scaleY={-camera.zoom} draggable={pan}
        onDragEnd={e => { if (e.target === e.target.getStage()) { autoFit.current = false; setCamera(c => ({ ...c, x: e.target.x(), y: e.target.y() })); } }}
        onWheel={e => { e.evt.preventDefault(); const p = e.target.getStage()?.getPointerPosition(); if (p) zoomAt(p.x, p.y, e.evt.deltaY < 0 ? 1.1 : 1 / 1.1); }} onClick={click} onTap={click}>
        <Layer>
          {groups.map(g => {
            const part = parts.get(`${g.sourceSnapshotId}:${g.detailId}`); if (!part) return null;
            const item = rendered.get(g.id); const paths = [...(item?.result?.geometry?.boundaries ?? []), ...(item?.result?.geometry?.milling ?? [])];
            const copies = expanded && selected.includes(g.id) ? Math.min(g.quantity, 200) : 1;
            if (!visible.includes(g.id)) return null;
            const view = item?.result?.visualization;
            return <Group key={g.id} x={g.xMm} y={g.yMm} rotation={g.rotationDeg} draggable={!readOnly && !pan && !measure}
              onClick={e => { if (tool !== 'select') return; e.cancelBubble = true; choose(g, e.evt.shiftKey || e.evt.ctrlKey); }}
              onTap={e => { if (tool !== 'select') return; e.cancelBubble = true; choose(g, false); }}
              onDragStart={() => { if (!selected.includes(g.id)) choose(g, false); }}
              onDragEnd={e => { e.cancelBubble = true; const dx = e.target.x() - g.xMm, dy = e.target.y() - g.yMm; const ids = selected.includes(g.id) ? selected : [g.id]; onChange(groups.map(v => ids.includes(v.id) ? { ...v, xMm: v.xMm + dx, yMm: v.yMm + dy } : v)); }}>
              {Array.from({ length: copies }, (_, n) => <Group key={n} x={n * (part.widthMm + 50)}>
                <Rect width={part.widthMm} height={part.heightMm} fill={finished && view ? 'rgba(0,0,0,0)' : '#fff'} stroke={selected.includes(g.id) ? '#2563eb' : item?.status === 'failed' ? '#dc2626' : '#65758b'} dash={item?.status !== 'succeeded' ? [6 / camera.zoom, 4 / camera.zoom] : undefined} strokeWidth={(selected.includes(g.id) ? 2 : 1) / camera.zoom} />
                {finished && view?.regions.filter(r => r.kind !== 'opening').map((r, i) => <Path key={`region-${i}`} data={regionPath(r.polygons)} fillRule="evenodd" fill={r.kind === 'material' ? '#f4e8ce' : r.kind === 'pocket' ? '#d5b982' : '#bb955f'} opacity={r.quality === 'exact' ? 1 : .7} listening={false} />)}
                {(trajectories || !view || view.quality !== 'exact') && paths.filter(p => !hiddenLayers.has(p.layer)).map(p => <Path key={p.path_id} data={cadPathData(p)} stroke={p.operation === 'part_boundary' ? '#344054' : '#07877e'} strokeWidth={1 / camera.zoom} listening={false} />)}
                {selected.includes(g.id) && <Rect width={part.widthMm} height={part.heightMm} stroke="#2563eb" strokeWidth={2 / camera.zoom} listening={false} />}
                {selected.length === 1 && selected[0] === g.id && view?.dimensions.filter(d => d.parameter === dimension).map(d => <Group key={d.parameter} listening={false}><Line points={d.points.flatMap(p => [p.x, p.y])} stroke="#c026d3" strokeWidth={3 / camera.zoom} closed={d.kind === 'region'} dash={d.kind === 'region' ? [5 / camera.zoom, 3 / camera.zoom] : undefined} /><Text x={d.points[0]?.x ?? 0} y={d.points[0]?.y ?? 0} scaleY={-1} fill="#a21caf" fontSize={14 / camera.zoom} text={`${d.value} ${d.kind === 'angle' ? '°' : 'мм'}`} /></Group>)}
                {(part.widthMm * camera.zoom >= 90 || selected.includes(g.id)) && <Text x={0} y={-12 / camera.zoom} scaleY={-1} fontSize={12 / camera.zoom} fill="#344054" listening={false} text={`№${part.orderId} / ${part.detailNumber} · ${copies > 1 ? `${n + 1}/${g.quantity}` : `×${g.quantity}`}`} />}
              </Group>)}
            </Group>;
          })}
          {points.length === 2 && <Group listening={false}><Line points={points.flatMap(p => [p.x, p.y])} stroke="#dc2626" strokeWidth={2 / camera.zoom} /><Text x={points[1].x} y={points[1].y} scaleY={-1} fontSize={14 / camera.zoom} fill="#dc2626" text={`${Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y).toFixed(2)} мм`} /></Group>}
        </Layer>
      </Stage>
    </div>
  </div>;
}
