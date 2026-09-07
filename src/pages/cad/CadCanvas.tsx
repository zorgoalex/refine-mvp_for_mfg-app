import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Group, Rect, Path, Text, Line } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { CadGroup, CadSourceSnapshot } from '@shared/cad-workspace';
import type { CadJob, CadPath } from '@shared/cad-api';
import { Button, Space } from 'antd';
import { loadCamera, saveCamera } from './cadViewState';

export function cadPathData(path: CadPath): string {
  if (path.segments.length) return path.segments.map((s, i) => `${i ? '' : `M${s.start.x},${s.start.y} `}${s.segment_type === 'arc' ? `A${s.radius_mm},${s.radius_mm} 0 ${s.large_arc ? 1 : 0} ${s.clockwise ? 0 : 1} ` : 'L'}${s.end.x},${s.end.y}`).join(' ') + (path.closed ? ' Z' : '');
  return path.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ') + (path.closed ? ' Z' : '');
}
interface Props {
  documentId: string;
  groups: CadGroup[]; sources: CadSourceSnapshot[]; job: CadJob | null; readOnly: boolean; selected: string[];
  onSelect: (ids: string[]) => void; onChange: (groups: CadGroup[]) => void; hiddenLayers: Set<string>; expanded: boolean;
}
export function CadCanvas({ documentId, groups, sources, job, readOnly, selected, onSelect, onChange, hiddenLayers, expanded }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 650 });
  const [camera, setCamera] = useState(() => loadCamera(documentId) ?? { x: 30, y: 620, zoom: .25 });
  useEffect(() => { const timer = setTimeout(() => saveCamera(documentId, camera), 200); return () => clearTimeout(timer); }, [documentId, camera]);
  const [pan, setPan] = useState(false);
  const [measure, setMeasure] = useState(false);
  const [points, setPoints] = useState<Array<{ x: number; y: number }>>([]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: Math.max(420, entry.contentRect.height) }));
    if (root.current) observer.observe(root.current); return () => observer.disconnect();
  }, []);
  const rendered = useMemo(() => new Map(job?.items.map(i => [i.part_id, i]) ?? []), [job]);
  const parts = useMemo(() => new Map(sources.flatMap(s => s.parts.map(p => [`${s.id}:${p.detailId}`, p] as const))), [sources]);
  const zoomAt = (x: number, y: number, factor: number) => setCamera(c => { const z = Math.max(.01, Math.min(8, c.zoom * factor)); return { zoom: z, x: x - (x - c.x) / c.zoom * z, y: y - (y - c.y) / c.zoom * z }; });
  const choose = (g: CadGroup, multi: boolean) => {
    const ids = g.placementGroupId ? groups.filter(v => v.placementGroupId === g.placementGroupId).map(v => v.id) : [g.id];
    onSelect(multi ? [...new Set([...selected, ...ids])] : ids);
  };
  const click = (event: KonvaEventObject<MouseEvent>) => {
    const stage = event.target.getStage(); const p = stage?.getPointerPosition();
    if (measure && p) setPoints(old => [...(old.length === 2 ? [] : old), { x: (p.x - camera.x) / camera.zoom, y: (camera.y - p.y) / camera.zoom }]);
    else if (event.target === stage) onSelect([]);
  };
  return <div className="cad-canvas-shell">
    <Space className="cad-canvas-tools" wrap>
      <Button onClick={() => zoomAt(size.width / 2, size.height / 2, 1.25)} aria-label="Увеличить">＋</Button>
      <Button onClick={() => zoomAt(size.width / 2, size.height / 2, .8)} aria-label="Уменьшить">−</Button>
      <Button onClick={() => { const maxX = Math.max(1000, ...groups.map(g => g.xMm + (parts.get(`${g.sourceSnapshotId}:${g.detailId}`)?.widthMm ?? 0))); const maxY = Math.max(1000, ...groups.map(g => g.yMm + (parts.get(`${g.sourceSnapshotId}:${g.detailId}`)?.heightMm ?? 0))); setCamera({ x: 25, y: size.height - 25, zoom: Math.min((size.width - 50) / maxX, (size.height - 50) / maxY) }); }}>Весь комплект</Button>
      <Button type={pan ? 'primary' : 'default'} onClick={() => setPan(!pan)}>Панорама</Button>
      <Button type={measure ? 'primary' : 'default'} onClick={() => { setMeasure(!measure); setPoints([]); }}>Измерить</Button>
      <span>{Math.round(camera.zoom * 100)}% · мм · Y ↑</span>
    </Space>
    <div ref={root} className="cad-canvas" role="img" aria-label="Контуры деталей и траектории фрезеровок">
      <Stage width={size.width} height={size.height} x={camera.x} y={camera.y} scaleX={camera.zoom} scaleY={-camera.zoom} draggable={pan}
        onDragEnd={e => { if (e.target === e.target.getStage()) setCamera(c => ({ ...c, x: e.target.x(), y: e.target.y() })); }}
        onWheel={e => { e.evt.preventDefault(); const p = e.target.getStage()?.getPointerPosition(); if (p) zoomAt(p.x, p.y, e.evt.deltaY < 0 ? 1.1 : 1 / 1.1); }} onClick={click}>
        <Layer>
          {groups.map(g => {
            const part = parts.get(`${g.sourceSnapshotId}:${g.detailId}`); if (!part) return null;
            const item = rendered.get(g.id); const paths = [...(item?.result?.geometry?.boundaries ?? []), ...(item?.result?.geometry?.milling ?? [])];
            const copies = expanded && selected.includes(g.id) ? Math.min(g.quantity, 200) : 1;
            const margin = Math.max(part.widthMm, part.heightMm) + 1000;
            if (g.xMm + margin < -camera.x / camera.zoom || g.xMm - margin > (size.width - camera.x) / camera.zoom || g.yMm + margin < (camera.y - size.height) / camera.zoom || g.yMm - margin > camera.y / camera.zoom) return null;
            return <Group key={g.id} x={g.xMm} y={g.yMm} rotation={g.rotationDeg} draggable={!readOnly && !pan && !measure}
              onClick={e => { if (measure) return; e.cancelBubble = true; choose(g, e.evt.shiftKey || e.evt.ctrlKey); }}
              onDragStart={() => { if (!selected.includes(g.id)) choose(g, false); }}
              onDragEnd={e => { e.cancelBubble = true; const dx = e.target.x() - g.xMm, dy = e.target.y() - g.yMm; const ids = selected.includes(g.id) ? selected : [g.id]; onChange(groups.map(v => ids.includes(v.id) ? { ...v, xMm: v.xMm + dx, yMm: v.yMm + dy } : v)); }}>
              {Array.from({ length: copies }, (_, n) => <Group key={n} x={n * (part.widthMm + 50)}>
                <Rect width={part.widthMm} height={part.heightMm} fill="#fff" stroke={selected.includes(g.id) ? '#2563eb' : item?.status === 'failed' ? '#dc2626' : '#65758b'} strokeWidth={(selected.includes(g.id) ? 2 : 1) / camera.zoom} />
                {paths.filter(p => !hiddenLayers.has(p.layer)).map(p => <Path key={p.path_id} data={cadPathData(p)} stroke={p.operation === 'part_boundary' ? '#344054' : '#07877e'} strokeWidth={1 / camera.zoom} listening={false} />)}
                <Text x={0} y={-12 / camera.zoom} scaleY={-1} fontSize={12 / camera.zoom} fill="#344054" listening={false} text={`№${part.orderId} / ${part.detailNumber} · ${copies > 1 ? `${n + 1}/${g.quantity}` : `×${g.quantity}`}`} />
              </Group>)}
            </Group>;
          })}
          {points.length === 2 && <Group listening={false}><Line points={points.flatMap(p => [p.x, p.y])} stroke="#dc2626" strokeWidth={2 / camera.zoom} /><Text x={points[1].x} y={points[1].y} scaleY={-1} fontSize={14 / camera.zoom} fill="#dc2626" text={`${Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y).toFixed(2)} мм`} /></Group>}
        </Layer>
      </Stage>
    </div>
  </div>;
}
