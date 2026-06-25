import React from 'react';
import { Tooltip } from 'antd';
import { displayedSheetExtents, formatSheetSide } from './cutPreviewHelpers';

interface RotatableImgProps {
  src: string;
  alt: string;
  boxW: number;
  boxH: number;
  rotate: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  style?: React.CSSProperties;
}

/** Renders an image into a boxW×boxH frame, optionally rotated 90° (clockwise).
 *  When rotated, the source image occupies the swapped (boxH×boxW) frame and is
 *  rotated about its centre, so its bounding box exactly fills boxW×boxH. */
function RotatableImg({ src, alt, boxW, boxH, rotate, onClick, onDoubleClick, style }: RotatableImgProps) {
  if (!rotate) {
    return (
      <img
        src={src}
        alt={alt}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        style={{ width: boxW, height: boxH, display: 'block', border: '1px solid #f0f0f0', ...style }}
      />
    );
  }
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ position: 'relative', width: boxW, height: boxH, border: '1px solid #f0f0f0', overflow: 'hidden', ...style }}
    >
      <img
        src={src}
        alt={alt}
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          width: boxH,
          height: boxW,
          transform: 'translate(-50%, -50%) rotate(90deg)',
          transformOrigin: 'center',
          display: 'block',
        }}
      />
    </div>
  );
}

const sideLabelStyle: React.CSSProperties = {
  position: 'absolute',
  color: '#595959',
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
};

export interface SheetPreviewProps {
  src: string;
  alt: string;
  widthMm: number;
  heightMm: number;
  /** Rotate the preview 90° so the long side is horizontal (vacuum-table jobs). */
  rotate: boolean;
  /** Full-size view: shows side-dimension labels and collapses on double-click.
   *  Thumbnail view: fixed height, opens full size on click. */
  full: boolean;
  thumbHeight?: number;
  fullWidth?: number;
  onOpen?: () => void;
  onCollapse?: () => void;
}

/** Cut-sheet layout preview. Thumbnail (click → open) or full size (side
 *  dimension labels, double-click → collapse), with optional landscape rotation. */
export function SheetPreview({
  src,
  alt,
  widthMm,
  heightMm,
  rotate,
  full,
  thumbHeight = 170,
  fullWidth = 900,
  onOpen,
  onCollapse,
}: SheetPreviewProps) {
  const { horizontalMm, verticalMm } = displayedSheetExtents(widthMm, heightMm, rotate);
  const aspect = horizontalMm > 0 && verticalMm > 0 ? horizontalMm / verticalMm : 1;

  if (!full) {
    const boxH = thumbHeight;
    const boxW = Math.round(thumbHeight * aspect);
    return (
      <div style={{ marginTop: 4 }}>
        <Tooltip title="Открыть лист в полном размере">
          <div style={{ cursor: 'pointer', display: 'inline-block' }}>
            <RotatableImg src={src} alt={alt} boxW={boxW} boxH={boxH} rotate={rotate} onClick={onOpen} />
          </div>
        </Tooltip>
      </div>
    );
  }

  const boxW = fullWidth;
  const boxH = Math.round(fullWidth / (aspect || 1));
  return (
    <div style={{ marginTop: 4, maxWidth: '100%', overflow: 'auto' }}>
      <Tooltip title="Двойной клик — свернуть до превью">
        {/* padding leaves room for the side-dimension labels */}
        <div style={{ position: 'relative', display: 'inline-block', padding: '22px 56px', cursor: 'zoom-out' }}>
          <RotatableImg
            src={src}
            alt={alt}
            boxW={boxW}
            boxH={boxH}
            rotate={rotate}
            onDoubleClick={onCollapse}
          />
          {/* top / bottom = horizontal extent; left / right = vertical extent */}
          <span style={{ ...sideLabelStyle, top: 2, left: '50%', transform: 'translateX(-50%)' }}>
            {formatSheetSide(horizontalMm)}
          </span>
          <span style={{ ...sideLabelStyle, bottom: 2, left: '50%', transform: 'translateX(-50%)' }}>
            {formatSheetSide(horizontalMm)}
          </span>
          <span style={{ ...sideLabelStyle, left: 4, top: '50%', transform: 'translateY(-50%) rotate(-90deg)', transformOrigin: 'left center' }}>
            {formatSheetSide(verticalMm)}
          </span>
          <span style={{ ...sideLabelStyle, right: 4, top: '50%', transform: 'translateY(-50%) rotate(90deg)', transformOrigin: 'right center' }}>
            {formatSheetSide(verticalMm)}
          </span>
        </div>
      </Tooltip>
    </div>
  );
}
