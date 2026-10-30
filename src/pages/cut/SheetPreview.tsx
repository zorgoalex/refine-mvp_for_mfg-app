import { Popover, Tooltip } from '../../ui/tooltipDelay';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Space } from 'antd';
import { CheckCircleFilled, FullscreenExitOutlined, FullscreenOutlined, MinusOutlined, PlusOutlined } from '@ant-design/icons';
import { OrderDeletedTag } from '../../components/OrderDeletedTag';
import { displayedSheetExtents, formatSheetSide, sheetImageHeadingShare, type CutPieceOverlay } from './cutPreviewHelpers';
import { fitLabelScale, LINE1_SCALE, splitDimsLine } from './pieceLabel';

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
  labelsInImage?: boolean;
  onOpen?: () => void;
  onCollapse?: () => void;
  /** Piece highlighted on the sheet (overlay key), e.g. the one pointed at in a parts list. */
  activeOverlayKey?: string | null;
  /** Pointer entered a piece on the sheet (`null` — left it). */
  onOverlayHover?: (key: string | null) => void;
  /** A piece on the sheet was clicked. */
  onOverlayPick?: (key: string) => void;
  /** Full view: «− 100% +» and full screen above the sheet («NewLine», mockup 09). */
  zoomControls?: boolean;
}

export const SHEET_ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3] as const;

/** Next zoom step up (+1) or down (−1); the ends stay. */
export function nextSheetZoom(current: number, direction: 1 | -1): number {
  const index = SHEET_ZOOM_STEPS.findIndex((step) => step >= current - 1e-9);
  const at = index < 0 ? SHEET_ZOOM_STEPS.length - 1 : index;
  const next = Math.min(SHEET_ZOOM_STEPS.length - 1, Math.max(0, at + direction));
  return SHEET_ZOOM_STEPS[next];
}

function renderOverlayTooltip(overlay: CutPieceOverlay): React.ReactNode {
  return (
    <div className="app-tabular" style={{ maxWidth: 520, maxHeight: 420, overflow: 'auto' }}>
      <Space size={4} wrap style={{ fontWeight: 700, marginBottom: 6 }}>
        <span>Заказ {overlay.orderId ?? '—'} · позиция {overlay.detailNumber ?? '—'}</span>
        <OrderDeletedTag deleted={overlay.orderDeleted} />
      </Space>
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

/** A piece pointed at in the parts list (or on the sheet itself): contour + tint. */
const ACTIVE_PIECE_STYLE: React.CSSProperties = {
  outline: '2px solid #1f5fe0',
  outlineOffset: -2,
  background: 'rgba(31, 95, 224, 0.18)',
  zIndex: 1,
};

function OverlayLayer({
  overlays,
  labelsInImage = false,
  imgWidthPx,
  imgHeightPx,
  onClick,
  onDoubleClick,
  activeKey,
  onHoverKey,
  onPickKey,
}: {
  overlays?: CutPieceOverlay[];
  labelsInImage?: boolean;
  /** Rendered image width in px (used for auto-shrink font fitting). */
  imgWidthPx: number;
  /** Rendered image height in px (used for auto-shrink font fitting). */
  imgHeightPx: number;
  onClick?: () => void;
  onDoubleClick?: () => void;
  activeKey?: string | null;
  onHoverKey?: (key: string | null) => void;
  onPickKey?: (key: string) => void;
}) {
  if (!overlays || overlays.length === 0) return null;
  return (
    <>
      {overlays.map((overlay) => {
        // Compute the overlay box's rendered pixel dimensions for font fitting.
        const boxWpx = imgWidthPx > 0 ? imgWidthPx * (overlay.widthPct / 100) : 0;
        const boxHpx = imgHeightPx > 0 ? imgHeightPx * (overlay.heightPct / 100) : 0;
        // line1Scale so the fit accounts for the order-name line being LINE1_SCALE× larger.
        const scale = fitLabelScale({
          lines: overlay.labelLines,
          boxW: boxWpx,
          boxH: boxHpx,
          baseFont: BASE_FONT_PX,
          line1Scale: LINE1_SCALE,
        });
        const font = BASE_FONT_PX * scale;
        const font0 = font * LINE1_SCALE;
        const warningIconSize = Math.max(10, Math.min(16, Math.min(boxWpx || 12, boxHpx || 12) * 0.22));

        return (
          // the parts list beside each sheet names the details; the full detail card opens on a right click
          <Popover key={overlay.key} content={renderOverlayTooltip(overlay)} trigger="contextMenu" placement="right" destroyTooltipOnHide>
            <span
              aria-label={`Заказ ${overlay.orderId ?? '—'}, позиция ${overlay.detailNumber ?? '—'}`}
              onClick={onPickKey ? () => { onPickKey(overlay.key); onClick?.(); } : onClick}
              onDoubleClick={onDoubleClick}
              onMouseEnter={onHoverKey ? () => onHoverKey(overlay.key) : undefined}
              onMouseLeave={onHoverKey ? () => onHoverKey(null) : undefined}
              data-piece-active={activeKey === overlay.key ? 'true' : undefined}
              style={{
                ...(activeKey === overlay.key ? ACTIVE_PIECE_STYLE : null),
                pointerEvents: 'auto',
                position: 'absolute',
                left: `${overlay.leftPct}%`,
                top: `${overlay.topPct}%`,
                width: `${overlay.widthPct}%`,
                height: `${overlay.heightPct}%`,
                cursor: onPickKey ? 'pointer' : 'default',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}
            >
              {overlay.vacuumOrientationWarning && (
                <Tooltip title={overlay.vacuumOrientationWarning.message}>
                  <span
                    aria-label={overlay.vacuumOrientationWarning.message}
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      zIndex: 2,
                      color: '#cf1322',
                      background: 'rgba(255,255,255,0.88)',
                      borderRadius: '50%',
                      lineHeight: 1,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: warningIconSize,
                    }}
                  >
                    <CheckCircleFilled />
                  </span>
                </Tooltip>
              )}
              {/* Optimizer-only label overlay. The PNG image has no baked labels
                  (backend renders with showLabels=false for the on-screen
                  preview), so this overlay is the sole label source.
                  L0 (order name) is large+bold; L2 (dims) has a half-size '*'.
                  A subtle semi-transparent background keeps it legible. */}
              {!labelsInImage && <span
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
                {overlay.labelLines.map((line, i) => {
                  const baseLineStyle: React.CSSProperties = {
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: '100%',
                    color: '#1d3557',
                  };
                  if (i === 0) {
                    // L0: order name — large + bold
                    return (
                      <span key={i} style={{ ...baseLineStyle, fontSize: font0, fontWeight: 600 }}>
                        {line}
                      </span>
                    );
                  }
                  if (i === 2) {
                    // L2: dims — render '*' at half size via 0.5em inner span
                    const dims = splitDimsLine(line);
                    if (dims) {
                      return (
                        <span key={i} style={{ ...baseLineStyle, fontSize: font }}>
                          {dims.w}
                          <span style={{ fontSize: '0.5em' }}>*</span>
                          {dims.h}
                        </span>
                      );
                    }
                  }
                  // L1 (position line) and fallback
                  return (
                    <span key={i} style={{ ...baseLineStyle, fontSize: font }}>
                      {line}
                    </span>
                  );
                })}
              </span>}
            </span>
          </Popover>
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
  labelsInImage = false,
  onOpen,
  onCollapse,
  activeOverlayKey,
  onOverlayHover,
  onOverlayPick,
  zoomControls = false,
}: SheetPreviewProps) {
  const [zoom, setZoom] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // width of the sheet at 100%: the frame minus the room for the side labels, as without the zoom
  const [baseWidth, setBaseWidth] = useState(0);
  // Track the full-view image's rendered pixel size (set via onLoad) so
  // OverlayLayer can compute pixel-accurate font sizes for label auto-shrink.
  const [fullImgSize, setFullImgSize] = useState({ w: 0, h: 0 });
  // Share of the image height taken by the job heading band the backend draws above the sheet.
  const [headingShare, setHeadingShare] = useState(0);

  // For the thumbnail the height is fixed (thumbHeight); width follows aspect ratio.
  const { horizontalMm, verticalMm } = displayedSheetExtents(widthMm, heightMm, landscape);

  // labels are fitted to the rendered size: re-measure after a zoom or full-screen change
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return undefined;
    const frame = requestAnimationFrame(() => setFullImgSize({ w: img.clientWidth, h: img.clientHeight }));
    return () => cancelAnimationFrame(frame);
  }, [zoom, fullscreen, baseWidth]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!zoomControls || !frame || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setBaseWidth(Math.max(0, Math.min(1800, frame.clientWidth - 112))));
    observer.observe(frame);
    return () => observer.disconnect();
  }, [zoomControls]);

  useEffect(() => {
    if (!zoomControls) return undefined;
    const onChange = () => setFullscreen(document.fullscreenElement === frameRef.current && frameRef.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [zoomControls]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void frameRef.current?.requestFullscreen?.();
  }, []);

  if (!full) {
    return (
      <div className="cut-sheet-thumb" style={{ marginTop: 4 }}>
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
          {/* Thumbnails show NO detail labels — only the cut layout. Detail data
              (order/position/dims) appears solely in the full (enlarged) view. */}
        </span>
      </div>
    );
  }

  return (
    <div
      ref={frameRef}
      className={`cut-sheet-full${fullscreen ? ' cut-sheet-full--fullscreen' : ''}`}
      style={{ marginTop: 4, maxWidth: '100%', overflow: 'auto' }}
    >
      {zoomControls ? (
        <div className="cut-sheet-zoom" role="group" aria-label="Масштаб листа">
          <Button size="small" icon={<MinusOutlined />} aria-label="Уменьшить" disabled={zoom <= SHEET_ZOOM_STEPS[0]} onClick={() => setZoom((value) => nextSheetZoom(value, -1))} />
          <Button size="small" className="cut-sheet-zoom__value" onClick={() => setZoom(1)} aria-label="Масштаб 100%">{`${Math.round(zoom * 100)}%`}</Button>
          <Button size="small" icon={<PlusOutlined />} aria-label="Увеличить" disabled={zoom >= SHEET_ZOOM_STEPS[SHEET_ZOOM_STEPS.length - 1]} onClick={() => setZoom((value) => nextSheetZoom(value, 1))} />
          <Button
            size="small"
            icon={fullscreen ? <FullscreenExitOutlined /> : <FullscreenOutlined />}
            aria-label={fullscreen ? 'Выйти из полноэкранного режима' : 'Во весь экран'}
            onClick={toggleFullscreen}
          />
        </div>
      ) : null}
      <Tooltip title="Двойной клик — свернуть до превью">
        {/* padding leaves room for the side-dimension labels */}
        <div style={{ position: 'relative', display: 'inline-block', padding: '22px 56px', cursor: 'zoom-out' }}>
          {/* Enlarged view ~2× the previous size: cap doubled (900 → 1800); the
              open sheet's wrapper in CutPage spans the full previews row so the
              image can actually grow to this width. */}
          <span
            style={{
              position: 'relative',
              display: 'inline-block',
              maxWidth: 1800,
              width: '100%',
              // «− 100% +»: the sheet gets an explicit width (100% = the width it had without the zoom)
              ...(zoomControls && baseWidth > 0 ? { maxWidth: 'none', width: Math.round(baseWidth * zoom) } : null),
            }}
          >
            <img
              ref={imgRef}
              className="app-image-outline"
              src={src}
              alt={alt}
              onDoubleClick={onCollapse}
              onLoad={(e) => {
                const img = e.currentTarget;
                setFullImgSize({ w: img.clientWidth, h: img.clientHeight });
                setHeadingShare(sheetImageHeadingShare(img.naturalWidth, img.naturalHeight, horizontalMm, verticalMm));
              }}
              style={{ width: '100%', display: 'block' }}
            />
            {/* overlays cover the sheet itself: the heading band above it is not part of the sheet */}
            <span
              style={{
                position: 'absolute',
                left: 0,
                top: `${headingShare * 100}%`,
                width: '100%',
                height: `${(1 - headingShare) * 100}%`,
                pointerEvents: 'none',
              }}
            >
              <OverlayLayer
                overlays={overlays}
                labelsInImage={labelsInImage}
                imgWidthPx={fullImgSize.w}
                imgHeightPx={fullImgSize.h * (1 - headingShare)}
                onDoubleClick={onCollapse}
                activeKey={activeOverlayKey}
                onHoverKey={onOverlayHover}
                onPickKey={onOverlayPick}
              />
            </span>
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
