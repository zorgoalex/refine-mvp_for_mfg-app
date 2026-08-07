import {
  CloseOutlined,
  PictureOutlined,
  PrinterOutlined,
  ReloadOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { Alert, Button, Modal, Spin, Tag, Tooltip, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cncTelegramApi } from '../../../../api/cncTelegramApi';
import { isApiError } from '../../../../api/apiError';
import type {
  CncTelegramOrderScreenshot,
  CncTelegramOrderScreenshotsResponse,
} from '../../../../api/types/cncTelegramApi.types';

const { Text } = Typography;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const SCALE_STEP = 0.25;
const RESTORE_POLL_MS = 2_500;

interface OrderTelegramScreenshotsProps {
  orderId?: number | null;
  compact?: boolean;
}

export function OrderTelegramScreenshots({ orderId, compact = false }: OrderTelegramScreenshotsProps) {
  const validOrderId = Number.isSafeInteger(orderId) && Number(orderId) > 0 ? Number(orderId) : null;
  const [response, setResponse] = useState<CncTelegramOrderScreenshotsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedPacketId, setSelectedPacketId] = useState<string | null>(null);
  const viewerPacketIdRef = useRef<string | null>(null);
  const [selectedPreviewUrl, setSelectedPreviewUrl] = useState<string | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const originalUrlRef = useRef<string | null>(null);
  const originalLoadingPacketRef = useRef<string | null>(null);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [restorePolling, setRestorePolling] = useState(false);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const selected = useMemo(
    () => response?.screenshots.find((item) => item.packetId === selectedPacketId) ?? null,
    [response, selectedPacketId],
  );

  const refresh = useCallback(async (silent = false) => {
    if (!validOrderId) return null;
    if (!silent) setLoading(true);
    try {
      const next = await cncTelegramApi.orderScreenshots(validOrderId);
      setResponse(next);
      setLoadError(null);
      return next;
    } catch (error) {
      if (!silent) setLoadError(readError(error, 'Не удалось загрузить скрины Telegram'));
      return null;
    } finally {
      if (!silent) setLoading(false);
    }
  }, [validOrderId]);

  const replaceOriginalUrl = useCallback((next: string | null) => {
    if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current);
    originalUrlRef.current = next;
    setOriginalUrl(next);
  }, []);

  useEffect(() => {
    viewerPacketIdRef.current = null;
    originalLoadingPacketRef.current = null;
    setResponse(null);
    setLoadError(null);
    setSelectedPacketId(null);
    setSelectedPreviewUrl(null);
    setOriginalLoading(false);
    setRestorePolling(false);
    setViewerError(null);
    replaceOriginalUrl(null);
    if (validOrderId) void refresh();
  }, [refresh, replaceOriginalUrl, validOrderId]);

  useEffect(() => () => {
    if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current);
  }, []);

  const requestRestore = useCallback(async (item: CncTelegramOrderScreenshot) => {
    if (!validOrderId) return;
    setViewerError(null);
    setRestorePolling(true);
    try {
      await cncTelegramApi.restoreOrderScreenshot(validOrderId, item.packetId);
      await refresh(true);
    } catch (error) {
      if (viewerPacketIdRef.current === item.packetId) {
        setRestorePolling(false);
        setViewerError(readError(error, 'Не удалось поставить скрин на восстановление'));
      }
    }
  }, [refresh, validOrderId]);

  const loadOriginal = useCallback(async (item: CncTelegramOrderScreenshot) => {
    if (!validOrderId || originalLoadingPacketRef.current === item.packetId) return;
    originalLoadingPacketRef.current = item.packetId;
    setOriginalLoading(true);
    setViewerError(null);
    try {
      const result = await cncTelegramApi.downloadOrderScreenshotImage(validOrderId, item.packetId);
      const nextUrl = URL.createObjectURL(result.blob);
      if (viewerPacketIdRef.current === item.packetId) {
        replaceOriginalUrl(nextUrl);
        setRestorePolling(false);
      } else {
        URL.revokeObjectURL(nextUrl);
      }
    } catch (error) {
      if (viewerPacketIdRef.current !== item.packetId) return;
      if (isApiError(error) && (error.status === 404 || error.status === 410)) {
        await requestRestore(item);
      } else {
        setViewerError(readError(error, 'Не удалось открыть оригинал скрина'));
      }
    } finally {
      if (originalLoadingPacketRef.current === item.packetId) {
        originalLoadingPacketRef.current = null;
      }
      if (viewerPacketIdRef.current === item.packetId) setOriginalLoading(false);
    }
  }, [replaceOriginalUrl, requestRestore, validOrderId]);

  useEffect(() => {
    if (!restorePolling || !selectedPacketId) return;
    let cancelled = false;
    const poll = async () => {
      const next = await refresh(true);
      if (cancelled || !next) return;
      const item = next.screenshots.find((candidate) => candidate.packetId === selectedPacketId);
      if (!item) {
        setRestorePolling(false);
        setViewerError('Скрин больше не связан с заказом');
        return;
      }
      if (item.restore?.status === 'failed') {
        setRestorePolling(false);
        setViewerError(item.restore.error || 'Telegram-воркер не смог восстановить скрин');
        return;
      }
      if (item.originalAvailable && item.restore?.status === 'completed') {
        setRestorePolling(false);
        await loadOriginal(item);
      }
    };
    const interval = window.setInterval(() => void poll(), RESTORE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [loadOriginal, refresh, restorePolling, selectedPacketId]);

  const openViewer = useCallback((item: CncTelegramOrderScreenshot, previewUrl: string | null) => {
    viewerPacketIdRef.current = item.packetId;
    replaceOriginalUrl(null);
    setSelectedPacketId(item.packetId);
    setSelectedPreviewUrl(previewUrl);
    setScale(1);
    setViewerError(null);
    setRestorePolling(false);
    if (item.originalAvailable) void loadOriginal(item);
    else void requestRestore(item);
  }, [loadOriginal, replaceOriginalUrl, requestRestore]);

  const closeViewer = useCallback(() => {
    viewerPacketIdRef.current = null;
    setSelectedPacketId(null);
    setSelectedPreviewUrl(null);
    setRestorePolling(false);
    setViewerError(null);
    setOriginalLoading(false);
    setScale(1);
    replaceOriginalUrl(null);
  }, [replaceOriginalUrl]);

  if (!validOrderId) return null;
  const screenshots = response?.screenshots ?? [];
  const displayedUrl = originalUrl || selectedPreviewUrl;
  const viewerStatus = originalLoading
    ? 'Загрузка оригинала…'
    : restorePolling
      ? 'Восстанавливаем оригинал из Telegram…'
      : originalUrl
        ? 'Оригинал'
        : 'Сохранённое превью';

  return (
    <section className={`order-telegram-screenshots${compact ? ' order-telegram-screenshots--compact' : ''}`}>
      <div className="order-telegram-screenshots__heading">
        <span>Скрины раскроя из Telegram</span>
        {screenshots.length > 0 ? <Tag>{screenshots.length}</Tag> : null}
      </div>
      {loading ? <Spin size="small" /> : null}
      {loadError ? (
        <Alert
          type="warning"
          showIcon
          message={loadError}
          action={<Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>Повторить</Button>}
        />
      ) : null}
      {!loading && !loadError && screenshots.length === 0 ? (
        <Text type="secondary">—</Text>
      ) : null}
      {screenshots.length > 0 ? (
        <div className="order-telegram-screenshots__grid">
          {screenshots.map((item) => (
            <TelegramScreenshotThumbnail
              key={item.packetId}
              orderId={validOrderId}
              item={item}
              onOpen={openViewer}
            />
          ))}
        </div>
      ) : null}

      <Modal
        open={Boolean(selected)}
        onCancel={closeViewer}
        footer={null}
        closable={false}
        width="calc(100vw - 24px)"
        style={{ top: 12, maxWidth: 'none', paddingBottom: 0 }}
        styles={{ body: { padding: 0 } }}
        destroyOnClose
        title={null}
      >
        <div className="order-telegram-viewer">
          <div className="order-telegram-viewer__toolbar">
            <div className="order-telegram-viewer__title">
              <strong>Скрин раскроя · Telegram #{selected?.sourceMessageId}</strong>
              <span>{viewerStatus}</span>
            </div>
            <div className="order-telegram-viewer__actions">
              <Tooltip title="Уменьшить">
                <Button aria-label="Уменьшить изображение" icon={<ZoomOutOutlined />} disabled={scale <= MIN_SCALE} onClick={() => setScale((value) => clampScale(value - SCALE_STEP))} />
              </Tooltip>
              <Button className="order-telegram-viewer__scale" onClick={() => setScale(1)} aria-label="Сбросить масштаб">
                {Math.round(scale * 100)}%
              </Button>
              <Tooltip title="Увеличить">
                <Button aria-label="Увеличить изображение" icon={<ZoomInOutlined />} disabled={scale >= MAX_SCALE} onClick={() => setScale((value) => clampScale(value + SCALE_STEP))} />
              </Tooltip>
              <Tooltip title={displayedUrl ? 'Печать текущего изображения' : 'Изображение ещё не загружено'}>
                <Button aria-label="Печать скрина" icon={<PrinterOutlined />} disabled={!displayedUrl} onClick={() => displayedUrl && printImage(displayedUrl, `Раскрой Telegram ${selected?.sourceMessageId ?? ''}`)}>
                  Печать
                </Button>
              </Tooltip>
              <Tooltip title="Закрыть">
                <Button aria-label="Закрыть просмотр" icon={<CloseOutlined />} onClick={closeViewer} />
              </Tooltip>
            </div>
          </div>
          {viewerError ? (
            <Alert
              className="order-telegram-viewer__alert"
              type="warning"
              showIcon
              message={viewerError}
              action={selected ? <Button size="small" icon={<ReloadOutlined />} onClick={() => void requestRestore(selected)}>Повторить</Button> : null}
            />
          ) : null}
          <div className="order-telegram-viewer__canvas" aria-live="polite">
            {displayedUrl ? (
              <img
                src={displayedUrl}
                alt={`Скрин раскроя из Telegram, сообщение ${selected?.sourceMessageId ?? ''}`}
                style={{ width: `${scale * 100}%` }}
              />
            ) : (
              <div className="order-telegram-viewer__placeholder">
                {originalLoading || restorePolling ? <Spin size="large" /> : <PictureOutlined />}
                <span>{viewerStatus}</span>
              </div>
            )}
          </div>
        </div>
      </Modal>
    </section>
  );
}

function TelegramScreenshotThumbnail({
  orderId,
  item,
  onOpen,
}: {
  orderId: number;
  item: CncTelegramOrderScreenshot;
  onOpen: (item: CncTelegramOrderScreenshot, previewUrl: string | null) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setFailed(false);
    void cncTelegramApi.downloadOrderScreenshotPreview(orderId, item.packetId)
      .then((result) => {
        objectUrl = URL.createObjectURL(result.blob);
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.packetId, orderId]);

  const restoreLabel = item.restore?.status === 'pending' || item.restore?.status === 'processing'
    ? 'Восстанавливается'
    : item.originalAvailable
      ? 'Оригинал доступен'
      : 'Нажмите для загрузки';
  return (
    <button
      type="button"
      className="order-telegram-screenshot-card"
      onClick={() => onOpen(item, url)}
      aria-label={`Открыть скрин раскроя Telegram ${item.sourceMessageId}`}
    >
      <span className="order-telegram-screenshot-card__image">
        {url ? <img src={url} alt="" /> : <span className="order-telegram-screenshot-card__placeholder"><PictureOutlined />{failed ? 'Превью недоступно' : 'Загрузка…'}</span>}
      </span>
      <span className="order-telegram-screenshot-card__meta">
        <strong>Telegram #{item.sourceMessageId}</strong>
        <span>{formatDate(item.sourceCreatedAt)} · {item.matchedDetailCount} поз.</span>
        <span className={item.originalAvailable ? 'is-available' : 'is-expired'}>{restoreLabel}</span>
      </span>
    </button>
  );
}

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(value.toFixed(2))));
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function readError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function printImage(url: string, title: string): void {
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
  documentRef.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>@page{margin:8mm}html,body{margin:0;width:100%;height:100%}body{display:flex;align-items:center;justify-content:center}img{max-width:100%;max-height:calc(100vh - 16mm);object-fit:contain}</style></head><body><img src="${escapeHtml(url)}" alt=""></body></html>`);
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
