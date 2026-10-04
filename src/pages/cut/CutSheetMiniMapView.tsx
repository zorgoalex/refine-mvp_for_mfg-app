import React, { useMemo } from 'react';
import type { SheetPlacements } from '../../api/types/cutApi.types';
import { buildSheetMiniMap } from './cutSheetMiniMap';

/** Schematic preview of a sheet for the NewLine sheet tiles: hatched sheet, pieces as filled rectangles. */
export function CutSheetMiniMapView({ placements, color }: { placements: SheetPlacements; color: string }) {
  const map = useMemo(() => buildSheetMiniMap(placements), [placements]);
  const patternId = `wb-sheet-mini-${React.useId().replace(/:/g, '')}`;
  const stroke = Math.max(map.widthMm, map.heightMm) / 230;
  return (
    <svg
      className="wb-cut-sheet-mini"
      viewBox={`0 0 ${map.widthMm} ${map.heightMm}`}
      role="img"
      aria-label={`Схема листа: ${map.rects.length} дет.`}
    >
      <defs>
        <pattern id={patternId} width={stroke * 3} height={stroke * 3} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect className="wb-cut-sheet-mini__bg" width={stroke * 3} height={stroke * 3} />
          <rect className="wb-cut-sheet-mini__hatch" width={stroke * 1.2} height={stroke * 3} />
        </pattern>
      </defs>
      <rect width={map.widthMm} height={map.heightMm} rx={stroke * 2} fill={`url(#${patternId})`} />
      {map.rects.map((rect, index) => (
        <rect
          key={index}
          x={rect.x}
          y={rect.y}
          width={rect.w}
          height={rect.h}
          fill={color}
          stroke="#1b2230"
          strokeOpacity={0.4}
          strokeWidth={stroke}
        />
      ))}
    </svg>
  );
}
