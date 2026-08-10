import {
  CloseOutlined,
  PrinterOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { Button, Modal, Tooltip } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';

export const DEFAULT_IMAGE_PREVIEW_SCALE = 0.25;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;

interface ImagePrintPreviewModalProps {
  open: boolean;
  imageUrl: string | null;
  title: string;
  status?: string;
  alt: string;
  printTitle: string;
  printHeader?: string;
  onClose: () => void;
  banner?: ReactNode;
  emptyContent?: ReactNode;
}

export function ImagePrintPreviewModal({
  open,
  imageUrl,
  title,
  status,
  alt,
  printTitle,
  printHeader,
  onClose,
  banner,
  emptyContent,
}: ImagePrintPreviewModalProps) {
  const [scale, setScale] = useState(DEFAULT_IMAGE_PREVIEW_SCALE);

  useEffect(() => {
    if (open) setScale(DEFAULT_IMAGE_PREVIEW_SCALE);
  }, [open]);

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width="calc(100vw - 24px)"
      style={{ top: 12, maxWidth: 'none', paddingBottom: 0 }}
      styles={{ body: { padding: 0 } }}
      destroyOnClose
      title={null}
    >
      <div className="order-telegram-viewer" onClick={(event) => event.stopPropagation()}>
        <div className="order-telegram-viewer__toolbar">
          <div className="order-telegram-viewer__title">
            <strong>{title}</strong>
            {status ? <span>{status}</span> : null}
          </div>
          <div className="order-telegram-viewer__actions">
            <Tooltip title="Уменьшить">
              <Button
                aria-label="Уменьшить изображение"
                icon={<ZoomOutOutlined />}
                disabled={scale <= MIN_SCALE}
                onClick={() => setScale((value) => clampScale(value - SCALE_STEP))}
              />
            </Tooltip>
            <Button
              className="order-telegram-viewer__scale"
              onClick={() => setScale(DEFAULT_IMAGE_PREVIEW_SCALE)}
              aria-label="Сбросить масштаб"
            >
              {Math.round(scale * 100)}%
            </Button>
            <Tooltip title="Увеличить">
              <Button
                aria-label="Увеличить изображение"
                icon={<ZoomInOutlined />}
                disabled={scale >= MAX_SCALE}
                onClick={() => setScale((value) => clampScale(value + SCALE_STEP))}
              />
            </Tooltip>
            <Tooltip title={imageUrl ? 'Печать текущего изображения' : 'Изображение ещё не загружено'}>
              <Button
                aria-label="Печать скрина"
                icon={<PrinterOutlined />}
                disabled={!imageUrl}
                onClick={() => imageUrl && printImage(imageUrl, printTitle, printHeader)}
              >
                Печать
              </Button>
            </Tooltip>
            <Tooltip title="Закрыть">
              <Button aria-label="Закрыть просмотр" icon={<CloseOutlined />} onClick={onClose} />
            </Tooltip>
          </div>
        </div>
        {banner}
        <div className="order-telegram-viewer__canvas" aria-live="polite">
          {imageUrl ? (
            <img src={imageUrl} alt={alt} style={{ width: `${scale * 100}%` }} />
          ) : emptyContent}
        </div>
      </div>
    </Modal>
  );
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(2))));
}

function printImage(url: string, title: string, header?: string): void {
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.width = '1px';
  frame.style.height = '1px';
  frame.style.opacity = '0';
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);
  const documentRef = frame.contentDocument;
  if (!documentRef) {
    frame.remove();
    return;
  }
  documentRef.open();
  const headerHtml = header
    ? `<header class="image-print-header">${escapeHtml(header)}</header>`
    : '';
  documentRef.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>@page{margin:8mm}html,body{margin:0;width:100%;height:100%}body{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start}.image-print-header{box-sizing:border-box;width:100%;margin:0 0 6mm;font-weight:700;font-size:20px;font-family:Arial,sans-serif;line-height:1.2;text-align:center;color:#111}.image-print-body{display:flex;flex:1;min-height:0;align-items:center;justify-content:center}img{display:block;max-width:100%;max-height:${header ? 'calc(100vh - 16mm - 32px)' : 'calc(100vh - 16mm)'};object-fit:contain}</style></head><body>${headerHtml}<main class="image-print-body"><img src="${escapeHtml(url)}" alt=""></main></body></html>`);
  documentRef.close();
  const image = documentRef.querySelector('img');
  const finish = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    window.setTimeout(() => frame.remove(), 60_000);
  };
  if (image?.complete) finish();
  else if (image) image.onload = finish;
  else frame.remove();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}
