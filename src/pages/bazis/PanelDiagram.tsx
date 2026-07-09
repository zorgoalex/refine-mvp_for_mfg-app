// Схема панели: контур в масштабе + отверстия из геометрии raw_json.
// Рисуем только когда данных достаточно (габариты панели и координаты).
//
// Система координат Базиса: X вдоль длины, Y вдоль ширины, origin — угол
// панели. В SVG ось Y направлена вниз, поэтому переворачиваем (привычный
// чертёжный вид: origin слева-снизу).

import React from 'react';
import { Space, Typography } from 'antd';
import type { HoleGeometry } from './parseNodeRaw';

const { Text } = Typography;

interface PanelDiagramProps {
  lengthMm: number;
  widthMm: number;
  holes: HoleGeometry[];
}

const MAX_RENDER_WIDTH = 640;
const PADDING = 14;

export const PanelDiagram: React.FC<PanelDiagramProps> = ({ lengthMm, widthMm, holes }) => {
  if (!(lengthMm > 0) || !(widthMm > 0) || holes.length === 0) {
    return null;
  }

  const scale = Math.min(MAX_RENDER_WIDTH / lengthMm, 420 / widthMm);
  const width = lengthMm * scale + PADDING * 2;
  const height = widthMm * scale + PADDING * 2;

  const toX = (x: number) => PADDING + x * scale;
  const toY = (y: number) => PADDING + (widthMm - y) * scale; // переворот оси Y

  const faceHoles = holes.filter((hole) => Math.abs(hole.dirZ) === 1);
  const edgeHoles = holes.filter((hole) => Math.abs(hole.dirZ) !== 1);

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Text strong>Схема отверстий ({holes.length})</Text>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ maxWidth: '100%', height: 'auto', background: '#fff', border: '1px solid #f0f0f0', borderRadius: 6 }}
      >
        {/* контур панели */}
        <rect
          x={PADDING}
          y={PADDING}
          width={lengthMm * scale}
          height={widthMm * scale}
          fill="#fafafa"
          stroke="#8c8c8c"
          strokeWidth={1.5}
        />
        {/* отверстия в пласть: сквозные залиты, глухие — контур; обратная сторона (dirZ=-1) пунктиром */}
        {faceHoles.map((hole, index) => {
          const radius = Math.max((hole.diameter / 2) * scale, 2.5);
          const through = hole.type === 'Сквозное';
          const backSide = hole.dirZ === -1;
          return (
            <circle
              key={`f-${index}`}
              cx={toX(hole.x)}
              cy={toY(hole.y)}
              r={radius}
              fill={through ? '#1677ff' : 'none'}
              fillOpacity={through ? 0.55 : undefined}
              stroke="#1677ff"
              strokeWidth={1.5}
              strokeDasharray={backSide ? '3 2' : undefined}
            >
              <title>
                {`Ø${hole.diameter} мм · ${hole.type ?? 'отверстие'}${hole.depth != null ? ` · глубина ${hole.depth} мм` : ''} · X=${hole.x}, Y=${hole.y}${backSide ? ' · с обратной стороны' : ''}`}
              </title>
            </circle>
          );
        })}
        {/* торцевые отверстия (в кромку): квадратный маркер на позиции */}
        {edgeHoles.map((hole, index) => {
          const size = Math.max(hole.diameter * scale, 5);
          return (
            <rect
              key={`e-${index}`}
              x={toX(hole.x) - size / 2}
              y={toY(hole.y) - size / 2}
              width={size}
              height={size}
              fill="#fa8c16"
              fillOpacity={0.7}
              stroke="#d46b08"
              strokeWidth={1}
            >
              <title>
                {`Торцевое Ø${hole.diameter} мм${hole.depth != null ? ` · глубина ${hole.depth} мм` : ''} · X=${hole.x}, Y=${hole.y}`}
              </title>
            </rect>
          );
        })}
      </svg>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {lengthMm}×{widthMm} мм · ● сквозное · ○ глухое · пунктир — обратная пласть · ▪ торцевое. Наведите на отверстие для деталей.
      </Text>
    </Space>
  );
};
