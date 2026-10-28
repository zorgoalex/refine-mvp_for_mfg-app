import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Drawer, Empty, Input, List, Modal, Space, Tag, Typography } from 'antd';
import { BulbFilled, BulbOutlined, EditOutlined, PictureOutlined, SettingOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { decodeQrFromFile, startQrScanner } from './qrScanner';
import { getScanAction, setScanAction } from './scanPrefs';
import type { ScanAction } from './scanPrefs';
import { labelsApi } from '../../api/labelsApi';
import { ApiError } from '../../api/httpClient';
import type { ScanCandidate, ScanResolveResult } from '../../api/types/labelsApi.types';
import { authSession } from '../../api/authSession';
import { useOptionalUiVariant } from '../../ui-variant/UiVariantProvider';
import { loadScanRecent, rememberScan } from './scanRecent';
import { setTorch, torchSupported } from './cameraTorch';

const { Text, Title } = Typography;

function candidateTitle(c: ScanCandidate): string {
  return `${c.orderName} · №${c.detailNumber ?? '—'}`;
}

function candidateSize(c: ScanCandidate): string {
  if (c.width && c.height) {
    return `${c.width}×${c.height}${c.quantity ? ` — ${c.quantity} шт` : ''}`;
  }
  return '—';
}

// Сырой matchedBy несёт весь текст QR-шаблона — в UI только короткая метка.
function matchedByLabel(c: ScanCandidate): string {
  return c.matchedBy.startsWith('qr-template') ? 'QR' : 'Поиск по строке';
}

// Неточный QR (без ID детали) матчит ВСЕ детали заказа. Если верхний кандидат
// строго обгоняет остальных по score (совпал ещё и номер позиции) — это и есть
// «та самая» деталь: действуем сразу, список показываем только при ничьей.
function confidentLeader(res: ScanResolveResult): ScanCandidate | null {
  if (res.candidates.length === 0) return null;
  if (res.candidates.length === 1) return res.candidates[0];
  return res.candidates[0].score > res.candidates[1].score ? res.candidates[0] : null;
}

// Последний результат скана переживает уход в заказ и возврат назад —
// per-вкладка (sessionStorage), per-пользователь.
const lastResultKey = (userId: number | string) => `scanLastResult:${userId}`;

function saveLastResult(userId: number | string, payload: string, result: ScanResolveResult): void {
  try {
    sessionStorage.setItem(lastResultKey(userId), JSON.stringify({ payload, result }));
  } catch {
    /* приватный режим/квота */
  }
}

function loadLastResult(userId: number | string): { payload: string; result: ScanResolveResult } | null {
  try {
    const raw = sessionStorage.getItem(lastResultKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { payload?: unknown; result?: { candidates?: unknown } };
    if (typeof parsed.payload !== 'string' || !Array.isArray(parsed.result?.candidates)) return null;
    return parsed as { payload: string; result: ScanResolveResult };
  } catch {
    return null;
  }
}

/**
 * Camera-first QR scanner for label lookup. Starts the camera on mount and
 * stops it on unmount/navigation (see the startQrScanner effect below). A
 * manual text-search fallback covers denied/missing-camera devices via the
 * same labelsApi.scanResolve backend call.
 */
export const ScanPage: React.FC = () => {
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stopScannerRef = useRef<(() => void) | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const userId = authSession.getUser()?.id ?? 'anon';
  const isWorkbench = useOptionalUiVariant()?.variant === 'workbench';
  const manualInputRef = useRef<HTMLDivElement | null>(null);
  const [cameraActive, setCameraActive] = useState(false);
  // Фонарик: дорожка камеры, если она умеет torch; null — кнопки нет.
  const [torchTrack, setTorchTrack] = useState<MediaStreamTrack | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [recent, setRecent] = useState<ScanCandidate[]>(() => loadScanRecent(userId));

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState('');
  const [resolving, setResolving] = useState(false);
  // scanError = the REQUEST failed (403/5xx/network) — distinct from an empty
  // result (request succeeded, nothing matched), which renders <Empty>.
  const [scanError, setScanError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResolveResult | null>(null);
  const [rawPayload, setRawPayload] = useState('');
  const [actionCandidate, setActionCandidate] = useState<ScanCandidate | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoCandidate, setInfoCandidate] = useState<ScanCandidate | null>(null);
  // Photo decoded locally but no QR found: hold the file so the user can opt
  // into server-side OCR instead of failing outright (kept on OCR error too,
  // so "Распознать текст бирки" doubles as a retry button).
  const [pendingOcrFile, setPendingOcrFile] = useState<File | null>(null);

  const applyAction = useCallback(
    (candidate: ScanCandidate, action: ScanAction) => {
      setRecent(rememberScan(userId, candidate));
      if (action === 'open-order') {
        navigate(`/orders/show/${candidate.orderId}?highlightDetail=${candidate.detailId}`);
      } else {
        setInfoCandidate(candidate);
      }
    },
    [navigate, userId],
  );

  // Shared candidate-selection path for BOTH the single-candidate auto-flow
  // and taps on multi-candidate list cards: apply the saved default action if
  // the user already chose one; only ask via the chooser modal on first use.
  const handleCandidateSelect = useCallback(
    (candidate: ScanCandidate) => {
      const prefAction = getScanAction(userId);
      if (prefAction) {
        applyAction(candidate, prefAction);
      } else {
        setActionCandidate(candidate);
      }
    },
    [applyAction, userId],
  );

  const handleResolved = useCallback(
    (payload: string, res: ScanResolveResult) => {
      setRawPayload(payload);
      setResult(res);
      saveLastResult(userId, payload, res);
      const leader = confidentLeader(res);
      if (leader) {
        handleCandidateSelect(leader);
      }
    },
    [handleCandidateSelect, userId],
  );

  // Возврат со страницы заказа (или reload вкладки): восстановить последний
  // результат скана — только отображение, без повторного авто-действия.
  useEffect(() => {
    const saved = loadLastResult(userId);
    if (saved) {
      setRawPayload(saved.payload);
      setResult(saved.result);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolvePayload = useCallback(
    async (payload: string, source: 'qr' | 'manual') => {
      setResolving(true);
      setScanError(null);
      // Any NEW search act (manual input, live QR, photo QR) invalidates a
      // photo held for the OCR fallback — otherwise the stale «QR-код на фото
      // не найден» Alert/retry button would linger next to fresh results and
      // the error-Alert's «Повторить» would silently re-OCR the OLD photo.
      // handleResolveOcr does NOT route through here (it copies the file to a
      // local const before its own request), so this reset never races it.
      setPendingOcrFile(null);
      try {
        const res = await labelsApi.scanResolve(payload, source);
        handleResolved(payload, res);
      } catch (err) {
        // A failed request is NOT "nothing found" — surface an honest error
        // instead of a misleading Empty state.
        setRawPayload(payload);
        setResult(null);
        if (err instanceof ApiError) {
          if (err.status === 403 || err.status === 401) {
            setScanError('Нет доступа к сканеру бирок. Обратитесь к администратору.');
          } else {
            setScanError('Сервис сканера временно недоступен. Попробуйте позже.');
          }
        } else {
          setScanError('Ошибка сети. Проверьте подключение и попробуйте ещё раз.');
        }
      } finally {
        setResolving(false);
      }
    },
    [handleResolved],
  );

  // Camera lifecycle: request the stream ONLY once the video element is
  // mounted, and always release it on unmount/route change so leaving /scan
  // never leaves the camera light on.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!videoRef.current) return;
      try {
        let track: MediaStreamTrack | null = null;
        const stop = await startQrScanner(videoRef.current, (text) => {
          void resolvePayload(text, 'qr');
        }, (videoTrack) => { track = videoTrack; });
        if (cancelled) {
          stop();
          return;
        }
        stopScannerRef.current = stop;
        setCameraActive(true);
        if (torchSupported(track)) setTorchTrack(track);
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (name === 'NotAllowedError') {
          setCameraError('Доступ к камере запрещён. Разрешите доступ в настройках браузера или введите данные вручную.');
        } else if (name === 'NotFoundError') {
          setCameraError('Камера не найдена. Введите данные вручную.');
        } else {
          setCameraError('Не удалось запустить камеру. Введите данные вручную.');
        }
      }
    })();
    return () => {
      cancelled = true;
      setCameraActive(false);
      setTorchTrack(null);
      setTorchOn(false);
      stopScannerRef.current?.();
      stopScannerRef.current = null;
    };
  }, [resolvePayload]);

  const toggleTorch = async () => {
    if (!torchTrack) return;
    const next = !torchOn;
    if (await setTorch(torchTrack, next)) setTorchOn(next);
  };

  const handleManualSearch = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void resolvePayload(trimmed, 'manual');
  };

  // Скан из фото-файла: декод QR локально (без камеры и сети), дальше тот же
  // resolve-путь, что и у live-скана. Если QR не найден — не сразу ошибка:
  // держим файл в pendingOcrFile и предлагаем серверный OCR-фоллбек бирки.
  const handlePhotoFile = async (file: File | null) => {
    if (!file) return;
    setResolving(true);
    setScanError(null);
    try {
      const text = await decodeQrFromFile(file);
      if (text) {
        // pendingOcrFile is reset inside resolvePayload (single source of truth).
        await resolvePayload(text, 'qr');
      } else {
        setResult(null);
        setPendingOcrFile(file);
      }
    } finally {
      setResolving(false);
      if (fileInputRef.current) fileInputRef.current.value = ''; // повторный выбор того же файла
    }
  };

  // OCR fallback: user opted in via "Распознать текст бирки" after a photo
  // decoded no QR. Same downstream resolve flow as QR/manual (confident
  // leader / list / Empty / sessionStorage) via handleResolved.
  const handleResolveOcr = async () => {
    const file = pendingOcrFile;
    if (!file) return;
    setResolving(true);
    setScanError(null);
    try {
      const res = await labelsApi.scanResolveImage(file);
      handleResolved(file.name, res);
      setPendingOcrFile(null);
    } catch (err) {
      setResult(null);
      if (err instanceof ApiError) {
        if (err.code === 'OCR_SERVICE_UNAVAILABLE') {
          setScanError('Распознавание временно недоступно');
        } else if (err.code === 'OCR_SERVICE_BUSY') {
          setScanError('Сканер занят, попробуйте через минуту');
        } else if (err.code === 'UNSUPPORTED_IMAGE_TYPE') {
          setScanError('Формат изображения не поддерживается');
        } else if (err.code === 'OCR_IMAGE_UNREADABLE') {
          setScanError('Не удалось прочитать изображение. Попробуйте другое фото.');
        } else if (err.status === 403 || err.status === 401) {
          setScanError('Нет доступа к сканеру бирок. Обратитесь к администратору.');
        } else {
          setScanError('Сервис сканера временно недоступен. Попробуйте позже.');
        }
      } else if ((err as { name?: string } | null)?.name === 'TimeoutError' || (err as { name?: string } | null)?.name === 'AbortError') {
        setScanError('Не удалось распознать за отведённое время. Попробуйте ещё раз или сфотографируйте бирку крупнее.');
      } else {
        setScanError('Ошибка сети. Проверьте подключение и попробуйте ещё раз.');
      }
      // Keep pendingOcrFile so the Alert can offer a retry of the same photo.
    } finally {
      setResolving(false);
    }
  };

  const handleChooseAction = (action: ScanAction) => {
    setScanAction(userId, action);
    if (actionCandidate) {
      const candidate = actionCandidate;
      setActionCandidate(null);
      applyAction(candidate, action);
    }
    setSettingsOpen(false);
  };

  const actionModalOpen = !!actionCandidate || settingsOpen;

  const cameraPill = cameraError
    ? <span className="wb-pill" data-tone="warning">Камера недоступна</span>
    : cameraActive
      ? <span className="wb-pill" data-tone="ready">Камера активна</span>
      : <span className="wb-pill">Камера запускается</span>;

  return (
    <div className={isWorkbench ? 'wb-scan' : undefined} style={isWorkbench ? undefined : { padding: 16, maxWidth: 480, margin: '0 auto' }}>
      {isWorkbench ? (
        <header className="wb-scan__head">
          <div className="wb-scan__titles">
            <h1>Сканер бирок</h1>
            <p>Наведите камеру на QR-код бирки детали — откроется заказ или карточка детали.</p>
          </div>
          <Button
            icon={<SettingOutlined />}
            aria-label="Настройки сканера"
            onClick={() => setSettingsOpen(true)}
          >
            Что делать при находке
          </Button>
        </header>
      ) : (
        <Space align="center" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }}>
          <Title level={4} style={{ margin: 0 }}>Сканер бирок</Title>
          <Button
            icon={<SettingOutlined />}
            aria-label="Настройки сканера"
            onClick={() => setSettingsOpen(true)}
          />
        </Space>
      )}

      <div className={isWorkbench ? 'wb-scan__column' : undefined}>
      {isWorkbench ? (
        <div className="wb-scan__status">
          <span className="wb-scan__status-title">Сканирование</span>
          {cameraPill}
        </div>
      ) : null}
      <div
        className={isWorkbench ? 'wb-scan__viewfinder' : undefined}
        style={isWorkbench ? undefined : {
          position: 'relative',
          width: '100%',
          // −15% по высоте против квадрата: результат/текст под сканером
          // виден без скролла даже с плашкой «Не найдено».
          aspectRatio: '1 / 0.85',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#000',
          marginBottom: 16,
        }}
      >
        <video ref={videoRef} muted playsInline style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        {isWorkbench ? (
          <div className="wb-scan__aim" aria-hidden="true"><i /><i /><i /><i /></div>
        ) : null}
        {torchTrack ? (
          <Button
            className="scan-torch"
            shape="circle"
            size="large"
            type={torchOn ? 'primary' : 'default'}
            icon={torchOn ? <BulbFilled /> : <BulbOutlined />}
            aria-label={torchOn ? 'Выключить фонарик' : 'Включить фонарик'}
            aria-pressed={torchOn}
            title={torchOn ? 'Выключить фонарик' : 'Фонарик'}
            onClick={() => void toggleTorch()}
            style={{ position: 'absolute', top: 10, right: 10, zIndex: 2 }}
          />
        ) : null}
        {!cameraError && (
          <div
            className={isWorkbench ? 'wb-scan__caption' : undefined}
            style={isWorkbench ? undefined : {
              position: 'absolute',
              bottom: 8,
              left: 0,
              right: 0,
              textAlign: 'center',
              color: '#fff',
              textShadow: '0 1px 2px rgba(0,0,0,0.7)',
              pointerEvents: 'none',
            }}
          >
            {isWorkbench ? 'Наведите на QR-код бирки' : 'Наведите на QR бирки'}
          </div>
        )}
        {isWorkbench && cameraError ? (
          <div className="wb-scan__caption">Камера не запущена — введите номер или выберите фото бирки</div>
        ) : null}
      </div>

      {cameraError && <Alert type="warning" showIcon message={cameraError} style={{ marginBottom: 16 }} />}

      {scanError && (
        <Alert
          type="error"
          showIcon
          message={scanError}
          action={
            pendingOcrFile ? (
              <Button size="small" loading={resolving} onClick={() => void handleResolveOcr()}>
                Повторить
              </Button>
            ) : undefined
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {!scanError && pendingOcrFile && (
        <Alert
          type="info"
          showIcon
          message="QR-код на фото не найден"
          description={
            resolving ? (
              <Text type="secondary">Распознаём бирку… (до 10 секунд)</Text>
            ) : (
              <Button size="small" onClick={() => void handleResolveOcr()}>
                Распознать текст бирки
              </Button>
            )
          }
          style={{ marginBottom: 16 }}
        />
      )}

      <div ref={manualInputRef} className={isWorkbench ? 'wb-scan__manual' : undefined}>
      {isWorkbench ? <label className="wb-scan__label" htmlFor="wb-scan-manual">Номер заказа, детали или строка QR</label> : null}
      <Input.Search
        id={isWorkbench ? 'wb-scan-manual' : undefined}
        size={isWorkbench ? 'large' : undefined}
        placeholder="Строка QR / № или имя заказа"
        enterButton="Найти"
        value={manualValue}
        onChange={(e) => setManualValue(e.target.value)}
        onSearch={handleManualSearch}
        loading={resolving}
        style={{ marginBottom: 8 }}
      />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.emf,.bmp"
        style={{ display: 'none' }}
        data-testid="scan-photo-input"
        onChange={(e) => void handlePhotoFile(e.target.files?.[0] ?? null)}
      />
      <Button
        block
        size={isWorkbench ? 'large' : undefined}
        icon={<PictureOutlined />}
        loading={resolving}
        onClick={() => fileInputRef.current?.click()}
        style={{ marginBottom: 16 }}
      >
        Скан из фото
      </Button>
      {isWorkbench && cameraError ? (
        <Button
          block
          size="large"
          icon={<EditOutlined />}
          className="wb-scan__focus-manual"
          onClick={() => manualInputRef.current?.querySelector('input')?.focus()}
        >
          Ввести номер вручную
        </Button>
      ) : null}

      {result && result.candidates.length > 1 && (
        <List
          className={isWorkbench ? 'wb-scan__candidates' : undefined}
          header={isWorkbench ? `Найдено деталей: ${result.candidates.length} — выберите нужную` : undefined}
          dataSource={result.candidates}
          renderItem={(candidate) => (
            <List.Item
              key={`${candidate.detailId}`}
              onClick={() => handleCandidateSelect(candidate)}
              style={{ cursor: 'pointer' }}
            >
              <Card size="small" style={{ width: '100%', overflow: 'hidden' }}>
                <Text strong ellipsis style={{ display: 'block' }}>{candidateTitle(candidate)}</Text>
                <Text style={{ display: 'block' }}>{candidateSize(candidate)}</Text>
                <Text type="secondary" ellipsis style={{ display: 'block' }}>{candidate.materialName ?? '—'}</Text>
                <Tag style={{ marginTop: 4 }}>{matchedByLabel(candidate)}</Tag>
                {candidate.productionStatusName && <Tag style={{ marginTop: 4 }}>{candidate.productionStatusName}</Tag>}
              </Card>
            </List.Item>
          )}
        />
      )}

      {result && result.candidates.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          style={{ margin: '8px 0' }}
          description="Не найдено"
        >
          {/* Сырые данные неизвестного QR: длина произвольная — переносим,
              не даём распирать вёрстку. */}
          <Text type="secondary" style={{ display: 'block', wordBreak: 'break-word', textAlign: 'left' }}>
            {rawPayload}
          </Text>
        </Empty>
      )}

      {isWorkbench && recent.length > 0 ? (
        <section className="wb-scan__recent" aria-label="Последние сканы">
          <h2>Последние сканы</h2>
          {recent.map((candidate) => (
            <button
              key={candidate.detailId}
              type="button"
              className="wb-scan__recent-item"
              onClick={() => handleCandidateSelect(candidate)}
            >
              <span className="wb-scan__recent-name">{candidateTitle(candidate)}</span>
              <span className="wb-scan__recent-size">{candidateSize(candidate)}</span>
            </button>
          ))}
        </section>
      ) : null}
      </div>

      <Modal
        title="Что делать при находке?"
        open={actionModalOpen}
        onCancel={() => {
          setActionCandidate(null);
          setSettingsOpen(false);
        }}
        footer={null}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button block onClick={() => handleChooseAction('open-order')}>Открыть заказ</Button>
          <Button block onClick={() => handleChooseAction('show-info')}>Показать информацию</Button>
        </Space>
      </Modal>

      <Drawer
        placement="bottom"
        open={!!infoCandidate}
        onClose={() => setInfoCandidate(null)}
        height="auto"
        title={infoCandidate ? candidateTitle(infoCandidate) : ''}
      >
        {infoCandidate && (
          <Space direction="vertical" style={{ width: '100%' }} className={isWorkbench ? 'wb-scan__info' : undefined}>
            {isWorkbench ? (
              <>
                <div className="wb-scan__info-size">
                  {infoCandidate.width && infoCandidate.height ? <>{`${infoCandidate.width} × ${infoCandidate.height}`}<small>мм</small></> : '—'}
                </div>
                <dl className="wb-scan__info-list">
                  <dt>Количество</dt><dd>{infoCandidate.quantity ? `${infoCandidate.quantity} шт` : '—'}</dd>
                  <dt>Материал</dt><dd>{infoCandidate.materialName ?? '—'}</dd>
                  <dt>Этап сейчас</dt><dd>{infoCandidate.productionStatusName ? <span className="wb-pill" data-tone="active">{infoCandidate.productionStatusName}</span> : '—'}</dd>
                </dl>
              </>
            ) : (
              <>
                <div>Размер: {candidateSize(infoCandidate)}</div>
                <div>Материал: {infoCandidate.materialName ?? '—'}</div>
                <div>Статус: {infoCandidate.productionStatusName ?? '—'}</div>
              </>
            )}
            <Button
              type="primary"
              block
              size={isWorkbench ? 'large' : undefined}
              onClick={() =>
                navigate(`/orders/show/${infoCandidate.orderId}?highlightDetail=${infoCandidate.detailId}`)
              }
            >
              Открыть заказ
            </Button>
          </Space>
        )}
      </Drawer>
    </div>
  );
};

export default ScanPage;
