import React from 'react';
import { Tooltip } from 'antd';
import { displayedSheetExtents, formatSheetSide, type CutPieceOverlay } from './cutPreviewHelpers';

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
  /** The displayed image is already oriented by the backend; this only maps the
   *  side-dimension labels (true → the horizontal extent is the sheet height). */
  landscape: boolean;
  /** Full-size view: side-dimension labels + collapse on double-click.
   *  Thumbnail view: fixed height, opens full size on click. */
  full: boolean;
  thumbHeight?: number;
  overlays?: CutPieceOverlay[];
  onOpen?: () => void;
  onCollapse?: () => void;
}

function renderOverlayTooltip(overlay: CutPieceOverlay): React.ReactNode {
  return (
    <div style={{ maxWidth: 520, maxHeight: 420, overflow: 'auto' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        Заказ {overlay.orderId ?? '—'} · деталь {overlay.orderDetailId ?? '—'}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(120px, 1fr)', columnGap: 10, rowGap: 3 }}>
        {overlay.tooltipRows.map((row, index) => (
          <React.Fragment key={`${row.label}:${index}`}>
            <span style={{ color: '#8c8c8c' }}>{row.label}</span>
            <span style={{ wordBreak: 'break-word' }}>{row.value}</span>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function OverlayLayer({
  overlays,
  onClick,
  onDoubleClick,
}: {
  overlays?: CutPieceOverlay[];
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  if (!overlays || overlays.length === 0) return null;
  return (
    <>
      {overlays.map((overlay) => (
        <Tooltip key={overlay.key} title={renderOverlayTooltip(overlay)} mouseEnterDelay={0.15}>
          <span
            aria-label={`Заказ ${overlay.orderId ?? '—'}, деталь ${overlay.orderDetailId ?? '—'}`}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            style={{
              position: 'absolute',
              left: `${overlay.leftPct}%`,
              top: `${overlay.topPct}%`,
              width: `${overlay.widthPct}%`,
              height: `${overlay.heightPct}%`,
              cursor: 'help',
              background: 'rgba(255,255,255,0.01)',
            }}
          />
        </Tooltip>
      ))}
    </>
  );
}

/** Cut-sheet layout preview. The image itself is rendered (and oriented, with
 *  upright labels) by the backend; this component sizes it, adds the four
 *  side-dimension labels in full view, and handles open/collapse. */
export function SheetPreview({
  src,
  alt,
  widthMm,
  heightMm,
  landscape,
  full,
  thumbHeight = 170,
  overlays,
  onOpen,
  onCollapse,
}: SheetPreviewProps) {
  if (!full) {
    return (
      <div style={{ marginTop: 4 }}>
        <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
          <Tooltip title="Открыть лист в полном размере">
            <img
              src={src}
              alt={alt}
              onClick={onOpen}
              style={{ height: thumbHeight, width: 'auto', maxWidth: '100%', cursor: 'pointer', border: '1px solid #f0f0f0', display: 'block' }}
            />
          </Tooltip>
          <OverlayLayer overlays={overlays} onClick={onOpen} />
        </span>
      </div>
    );
  }

  const { horizontalMm, verticalMm } = displayedSheetExtents(widthMm, heightMm, landscape);
  return (
    <div style={{ marginTop: 4, maxWidth: '100%', overflow: 'auto' }}>
      <Tooltip title="Двойной клик — свернуть до превью">
        {/* padding leaves room for the side-dimension labels */}
        <div style={{ position: 'relative', display: 'inline-block', padding: '22px 56px', cursor: 'zoom-out' }}>
          <span style={{ position: 'relative', display: 'inline-block', maxWidth: 900, width: '100%' }}>
            <img
              src={src}
              alt={alt}
              onDoubleClick={onCollapse}
              style={{ width: '100%', border: '1px solid #f0f0f0', display: 'block' }}
            />
            <OverlayLayer overlays={overlays} onDoubleClick={onCollapse} />
          </span>
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
