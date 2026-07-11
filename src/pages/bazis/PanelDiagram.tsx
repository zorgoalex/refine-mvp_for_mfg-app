// Схема панели: контур в масштабе + отверстия из геометрии raw_json.
// Управление: зум ×2/÷2, поворот на 90°, размеры сторон на выносках.
// Рисуем только когда данных достаточно (габариты панели и координаты).
//
// Система координат Базиса: X вдоль длины, Y вдоль ширины, origin — угол
// панели. В SVG ось Y направлена вниз, поэтому переворачиваем (привычный
// чертёжный вид: origin слева-снизу). Поворот реализован пересчётом
// координат (не CSS-rotate), чтобы подписи размеров оставались ровными.

import React, { useMemo, useState } from 'react';
import {
  RotateLeftOutlined,
  RotateRightOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { Button, Space, Tooltip, Typography } from 'antd';
import type { HoleGeometry } from './parseNodeRaw';

const { Text } = Typography;

interface PanelDiagramProps {
  lengthMm: number;
  widthMm: number;
  holes: HoleGeometry[];
}

const BASE_RENDER_WIDTH = 640;
const BASE_RENDER_HEIGHT = 420;
/** Отступы под подписи размеров (слева и снизу) */
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PAD_TOP = 16;
const PAD_BOTTOM = 40;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;

export const PanelDiagram: React.FC<PanelDiagramProps> = ({ lengthMm, widthMm, holes }) => {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0); // 0 | 90 | 180 | 270

  const geometry = useMemo(() => {
    const rotated = rotation % 180 !== 0;
    const boardW = rotated ? widthMm : lengthMm; // горизонтальный габарит на экране
    const boardH = rotated ? lengthMm : widthMm; // вертикальный габарит на экране

    const transform = (x: number, y: number): { x: number; y: number } => {
      switch (rotation) {
        case 90:
          return { x: widthMm - y, y: x };
        case 180:
          return { x: lengthMm - x, y: widthMm - y };
        case 270:
          return { x: y, y: lengthMm - x };
        default:
          return { x, y };
      }
    };

    return { boardW, boardH, transform };
  }, [lengthMm, rotation, widthMm]);

  if (!(lengthMm > 0) || !(widthMm > 0) || holes.length === 0) {
    return null;
  }

  const { boardW, boardH, transform } = geometry;
  const scale = Math.min(BASE_RENDER_WIDTH / boardW, BASE_RENDER_HEIGHT / boardH) * zoom;
  const svgWidth = boardW * scale + PAD_LEFT + PAD_RIGHT;
  const svgHeight = boardH * scale + PAD_TOP + PAD_BOTTOM;

  const toX = (x: number) => PAD_LEFT + x * scale;
  const toY = (y: number) => PAD_TOP + (boardH - y) * scale; // переворот оси Y

  const faceHoles = holes.filter((hole) => Math.abs(hole.dirZ) === 1);
  const edgeHoles = holes.filter((hole) => Math.abs(hole.dirZ) !== 1);

  const holeTitle = (hole: HoleGeometry, edge: boolean): string => {
    const back = hole.dirZ === -1;
    return [
      `${edge ? 'Торцевое ' : ''}Ø${hole.diameter} мм`,
      hole.type ?? null,
      hole.depth != null ? `глубина ${hole.depth} мм` : null,
      `X=${hole.x}, Y=${hole.y}`,
      back ? 'с обратной стороны' : null,
    ].filter(Boolean).join(' · ');
  };

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Text strong>Схема отверстий ({holes.length})</Text>
        <Tooltip title="Увеличить в 2 раза">
          <Button
            size="small"
            icon={<ZoomInOutlined />}
            disabled={zoom >= MAX_ZOOM}
            onClick={() => setZoom((value) => Math.min(value * 2, MAX_ZOOM))}
          />
        </Tooltip>
        <Tooltip title="Уменьшить в 2 раза">
          <Button
            size="small"
            icon={<ZoomOutOutlined />}
            disabled={zoom <= MIN_ZOOM}
            onClick={() => setZoom((value) => Math.max(value / 2, MIN_ZOOM))}
          />
        </Tooltip>
        <Tooltip title="Повернуть против часовой">
          <Button
            size="small"
            icon={<RotateLeftOutlined />}
            onClick={() => setRotation((value) => (value + 270) % 360)}
          />
        </Tooltip>
        <Tooltip title="Повернуть по часовой">
          <Button
            size="small"
            icon={<RotateRightOutlined />}
            onClick={() => setRotation((value) => (value + 90) % 360)}
          />
        </Tooltip>
        <Text type="secondary">×{zoom} · {rotation}°</Text>
      </Space>

      <div style={{ maxWidth: '100%', overflow: 'auto', border: '1px solid #f0f0f0', borderRadius: 6, background: '#fff' }}>
        <svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${svgWidth} ${svgHeight}`}>
          {/* контур панели */}
          <rect
            x={PAD_LEFT}
            y={PAD_TOP}
            width={boardW * scale}
            height={boardH * scale}
            fill="#fafafa"
            stroke="#8c8c8c"
            strokeWidth={1.5}
          />

          {/* размеры сторон */}
          <text
            x={PAD_LEFT + (boardW * scale) / 2}
            y={PAD_TOP + boardH * scale + 26}
            textAnchor="middle"
            fontSize={13}
            fill="#595959"
          >
            {formatMm(boardW)} мм
          </text>
          <text
            x={PAD_LEFT - 12}
            y={PAD_TOP + (boardH * scale) / 2}
            textAnchor="middle"
            fontSize={13}
            fill="#595959"
            transform={`rotate(-90 ${PAD_LEFT - 12} ${PAD_TOP + (boardH * scale) / 2})`}
          >
            {formatMm(boardH)} мм
          </text>

          {/* отверстия в пласть */}
          {faceHoles.map((hole, index) => {
            const point = transform(hole.x, hole.y);
            const radius = Math.max((hole.diameter / 2) * scale, 2.5);
            const through = hole.type === 'Сквозное';
            const backSide = hole.dirZ === -1;
            const cx = toX(point.x);
            const cy = toY(point.y);
            return (
              <g key={`f-${index}`}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={radius}
                  fill={through ? '#1677ff' : 'none'}
                  fillOpacity={through ? 0.55 : undefined}
                  stroke="#1677ff"
                  strokeWidth={1.5}
                  strokeDasharray={backSide ? '3 2' : undefined}
                  pointerEvents="none"
                />
                {/* невидимая увеличенная зона наведения — тултип ловится «примерным» курсором */}
                <circle cx={cx} cy={cy} r={Math.max(radius + 7, 11)} fill="transparent">
                  <title>{holeTitle(hole, false)}</title>
                </circle>
              </g>
            );
          })}

          {/* торцевые отверстия (в кромку) */}
          {edgeHoles.map((hole, index) => {
            const point = transform(hole.x, hole.y);
            const size = Math.max(hole.diameter * scale, 5);
            const cx = toX(point.x);
            const cy = toY(point.y);
            return (
              <g key={`e-${index}`}>
                <rect
                  x={cx - size / 2}
                  y={cy - size / 2}
                  width={size}
                  height={size}
                  fill="#fa8c16"
                  fillOpacity={0.7}
                  stroke="#d46b08"
                  strokeWidth={1}
                  pointerEvents="none"
                />
                <circle cx={cx} cy={cy} r={Math.max(size / 2 + 7, 11)} fill="transparent">
                  <title>{holeTitle(hole, true)}</title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>

      <Text type="secondary" style={{ fontSize: 12 }}>
        ● сквозное · ○ глухое · пунктир — обратная пласть · ▪ торцевое. Наведите курсор рядом с отверстием для деталей.
      </Text>
    </Space>
  );
};

function formatMm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
