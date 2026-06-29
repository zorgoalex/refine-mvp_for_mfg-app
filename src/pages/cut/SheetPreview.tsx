import React, { useState } from 'react';
import { Tooltip } from 'antd';
import { displayedSheetExtents, formatSheetSide, type CutPieceOverlay } from './cutPreviewHelpers';
import { fitLabelScale } from './pieceLabel';

const sideLabelStyle: React.CSSProperties = {
  position: 'absolute',
  color: '#595959',
  fontSize: 12,
  fontWeight: 600,
  fontVariantNumeric: 'tabular-nums',
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
    <div className="app-tabular" style={{ maxWidth: 520, maxHeight: 420, overflow: 'auto' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        Заказ {overlay.orderId ?? '—'} · позиция {overlay.detailNumber ?? '—'}
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

const BASE_FONT_PX = 11;

function OverlayLayer({
  overlays,
  imgWidthPx,
  imgHeightPx,
  onClick,
  onDoubleClick,
}: {
  overlays?: CutPieceOverlay[];
  /** Rendered image width in px (used for auto-shrink font fitting). */
  imgWidthPx: number;
  /** Rendered image height in px (used for auto-shrink font fitting). */
  imgHeightPx: number;
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  if (!overlays || overlays.length === 0) return null;
  return (
    <>
      {overlays.map((overlay) => {
        // Compute the overlay box's rendered pixel dimensions for font fitting.
        const boxWpx = imgWidthPx > 0 ? imgWidthPx * (overlay.widthPct / 100) : 0;
        const boxHpx = imgHeightPx > 0 ? imgHeightPx * (overlay.heightPct / 100) : 0;
        const scale = fitLabelScale({
          lines: overlay.labelLines,
          boxW: boxWpx,
          boxH: boxHpx,
          baseFont: BASE_FONT_PX,
        });
        const font = BASE_FONT_PX * scale;

        return (
          <Tooltip key={overlay.key} title={renderOverlayTooltip(overlay)} mouseEnterDelay={0.15}>
            <span
              aria-label={`Заказ ${overlay.orderId ?? '—'}, позиция ${overlay.detailNumber ?? '—'}`}
              onClick={onClick}
              onDoubleClick={onDoubleClick}
              style={{
                position: 'absolute',
                left: `${overlay.leftPct}%`,
                top: `${overlay.topPct}%`,
                width: `${overlay.widthPct}%`,
                height: `${overlay.heightPct}%`,
                cursor: 'help',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {/* 3-line label overlay. The PNG image has no baked labels
                  (backend renders with showLabels=false for the on-screen
                  preview), so this overlay is the sole label source.
                  A subtle semi-transparent background keeps it legible over
                  the coloured piece fill without obscuring the layout. */}
              <span
                style={{
                  background: 'rgba(255,255,255,0.78)',
                  borderRadius: 3,
                  padding: '1px 4px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  lineHeight: 1.15,
                  pointerEvents: 'none',
                  maxWidth: '90%',
                  overflow: 'hidden',
                }}
              >
                {overlay.labelLines.map((line, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: font,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: '100%',
                      color: '#1d3557',
                    }}
                  >
                    {line}
                  </span>
                ))}
              </span>
            </span>
          </Tooltip>
        );
      })}
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
  // Track the full-view image's rendered pixel size (set via onLoad) so
  // OverlayLayer can compute pixel-accurate font sizes for label auto-shrink.
  const [fullImgSize, setFullImgSize] = useState({ w: 0, h: 0 });

  // For the thumbnail the height is fixed (thumbHeight); width follows aspect ratio.
  const { horizontalMm, verticalMm } = displayedSheetExtents(widthMm, heightMm, landscape);
  const thumbAspect = verticalMm > 0 ? horizontalMm / verticalMm : 1;
  const thumbImgW = thumbHeight * thumbAspect;
  const thumbImgH = thumbHeight;

  if (!full) {
    return (
      <div style={{ marginTop: 4 }}>
        <span style={{ position: 'relative', display: 'inline-block', maxWidth: '100%' }}>
          <Tooltip title="Открыть лист в полном размере">
            <img
              className="app-image-outline"
              src={src}
              alt={alt}
              onClick={onOpen}
              style={{ height: thumbHeight, width: 'auto', maxWidth: '100%', cursor: 'pointer', display: 'block' }}
            />
          </Tooltip>
          <OverlayLayer
            overlays={overlays}
            imgWidthPx={thumbImgW}
            imgHeightPx={thumbImgH}
            onClick={onOpen}
          />
        </span>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4, maxWidth: '100%', overflow: 'auto' }}>
      <Tooltip title="Двойной клик — свернуть до превью">
        {/* padding leaves room for the side-dimension labels */}
        <div style={{ position: 'relative', display: 'inline-block', padding: '22px 56px', cursor: 'zoom-out' }}>
          {/* Enlarged view ~2× the previous size: cap doubled (900 → 1800); the
              open sheet's wrapper in CutPage spans the full previews row so the
              image can actually grow to this width. */}
          <span style={{ position: 'relative', display: 'inline-block', maxWidth: 1800, width: '100%' }}>
            <img
              className="app-image-outline"
              src={src}
              alt={alt}
              onDoubleClick={onCollapse}
              onLoad={(e) => {
                const img = e.currentTarget;
                setFullImgSize({ w: img.clientWidth, h: img.clientHeight });
              }}
              style={{ width: '100%', display: 'block' }}
            />
            <OverlayLayer
              overlays={overlays}
              imgWidthPx={fullImgSize.w}
              imgHeightPx={fullImgSize.h}
              onDoubleClick={onCollapse}
            />
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
