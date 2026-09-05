import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Empty, InputNumber, Modal, Pagination, Progress, Space, Spin, Steps, Tabs, Tag, Typography, message } from 'antd';
import type { ColumnsType, TableProps } from 'antd/es/table';
import { CheckCircleOutlined, CloseOutlined, ExclamationCircleOutlined, LinkOutlined, SearchOutlined, SendOutlined, ZoomInOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { ApiError } from '../../api/httpClient';
import { can } from '../../utils/permissions';
import { featureFlags } from '../../config/featureFlags';
import { useCncTelegramImport } from '../../hooks/useCncTelegramImport';
import { useCutJobNumberChecks } from '../../hooks/useCutJobNumberChecks';
import type { CncTelegramImportCandidate, CncTelegramImportItem, CncTelegramImportMatch, CncTelegramImportMessage, CncTelegramImportScan } from '../../api/types/cncTelegramImportApi.types';
import { buildStyledCutLayoutPreview } from './svgCutRenderPreview';
import { candidateLayoutSummary, candidateScreenshotLabel, eligibleCandidateIdForMessage, importMessageAttachmentLabel, importMessageHumanContent, importMessageTimeLabel, needsDuplicateReconfirmation, repeatableItems, sortImportMessages } from './cutTelegramImportHelpers';
import { Table } from '../../ui/tooltipDelay';

const { Text, Paragraph } = Typography;
const MAX_SCAN_DAYS = 31;
const DEFAULT_SCAN_DAYS = 3;

interface CutTelegramImportModalProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}

type ImportStep = 0 | 1 | 2;
type MessageViewMode = 'original' | 'technical';

function defaultRange(now: Dayjs = dayjs()): [Dayjs, Dayjs] {
  return [now.subtract(DEFAULT_SCAN_DAYS - 1, 'day').startOf('day'), now.endOf('day')];
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function candidateDuplicate(candidate: CncTelegramImportCandidate): boolean {
  return candidate.matches.length > 0 || candidate.sourceStatus === 'similar' || candidate.sourceStatus === 'previously_imported';
}

function matchLabel(match: CncTelegramImportMatch): string {
  if (match.label) return match.label;
  if (match.kind === 'same_layout') return 'Похожий раскрой';
  if (match.kind === 'exact_svg_content') return 'Совпадает SVG';
  if (match.kind === 'sent_by_erp_manual_upload') return 'Отправлен из ERP';
  return 'Это сообщение уже известно ERP';
}

function sourceStatusLabel(status: CncTelegramImportCandidate['sourceStatus']): string {
  return {
    new: 'Новый',
    similar: 'Есть похожий',
    previously_imported: 'Уже импортирован',
    incomplete: 'Неполный комплект',
    source_changed: 'Источник изменён',
    expired: 'Истёк срок',
  }[status];
}

function itemStatusLabel(status: CncTelegramImportItem['status']): string {
  return {
    pending: 'Ожидает',
    processing: 'Создаётся',
    confirmation_required: 'Нужно подтверждение',
    imported: 'Создано',
    failed: 'Ошибка',
    unknown: 'Неизвестно',
  }[status];
}

function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith('/')) return value;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

const DuplicateMatches: React.FC<{ matches: CncTelegramImportMatch[] }> = ({ matches }) => {
  if (matches.length === 0) return null;
  return (
    <div className="cut-telegram-import__matches">
      <Text type="warning"><ExclamationCircleOutlined /> Похожие раскрои уже есть — создание не запрещено</Text>
      <Space direction="vertical" size={2}>
        {matches.map((match, index) => {
          const href = safeHref(match.href);
          const target = match.cutJobDisplayNumber ?? match.cutJobId;
          return (
            <span key={`${match.kind}-${target ?? index}`}>
              {href ? <a href={href}><LinkOutlined /> {target ? `Раскрой ${target}` : matchLabel(match)}</a> : matchLabel(match)}
            </span>
          );
        })}
      </Space>
    </div>
  );
};

const CandidateDetails: React.FC<{ candidate: CncTelegramImportCandidate }> = ({ candidate }) => {
  const summary = candidateLayoutSummary(candidate);
  return (
    <div className="cut-telegram-import__candidate-details">
      <div className="cut-telegram-import__file-line">
        <Text strong>{candidate.svgFileName}</Text>
        <Tag color={candidateDuplicate(candidate) ? 'warning' : 'default'}>{sourceStatusLabel(candidate.sourceStatus)}</Tag>
      </div>
      <Text type="secondary">{formatDate(candidate.sourceCreatedAt)} · {summary.sheetCount ?? '—'} листов · {summary.positionCount ?? '—'} позиций</Text>
      <Text type="secondary">
        G-code: {candidate.gcodeFileName ?? 'нет'} · скриншот: {candidateScreenshotLabel(candidate)}
      </Text>
      {(summary.sheetWidthMm != null || summary.sheetHeightMm != null) && (
        <Text type="secondary">Лист: {summary.sheetWidthMm ?? '—'} × {summary.sheetHeightMm ?? '—'} мм</Text>
      )}
      {summary.orderLabels.length > 0 && <Text type="secondary">Заказы: {summary.orderLabels.join(', ')}</Text>}
      {candidate.parserWarnings.length > 0 && <Text type="warning">Предупреждения парсера: {candidate.parserWarnings.join('; ')}</Text>}
      <DuplicateMatches matches={candidate.matches} />
    </div>
  );
};

interface PreviewImage {
  src: string;
  alt: string;
}

const PreviewLightbox: React.FC<{ preview: PreviewImage | null; onClose: () => void }> = ({ preview, onClose }) => {
  useEffect(() => {
    if (!preview) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, preview]);

  return (
    <Modal
      className="cut-telegram-import__lightbox"
      open={Boolean(preview)}
      title={preview?.alt ?? 'Полноразмерный просмотр'}
      width="min(1000px, 92vw)"
      footer={null}
      centered
      keyboard
      onCancel={onClose}
      closable={false}
      destroyOnClose
    >
      {preview && (
        <div className="cut-telegram-import__lightbox-content">
          <Button
            type="text"
            className="cut-telegram-import__lightbox-close"
            icon={<CloseOutlined />}
            aria-label="Закрыть полноразмерный просмотр"
            onClick={onClose}
          />
          <img className="cut-telegram-import__lightbox-image" src={preview.src} alt={preview.alt} />
        </div>
      )}
    </Modal>
  );
};

const CandidatePreview: React.FC<{ candidate: CncTelegramImportCandidate; onOpenPreview: (preview: PreviewImage) => void }> = ({ candidate, onOpenPreview }) => {
  const previewUrl = useMemo(() => {
    if (candidate.previewUrl) return candidate.previewUrl;
    const layout = candidate.cutLayout;
    if (!layout || layout.status !== 'valid' || !layout.sheet || layout.items.length === 0) return null;
    try {
      const svg = buildStyledCutLayoutPreview(layout);
      return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
    } catch {
      return null;
    }
  }, [candidate.cutLayout, candidate.previewUrl]);

  if (previewUrl) {
    const preview = { src: previewUrl, alt: `Превью раскроя ${candidate.svgFileName}` };
    return (
      <div className="cut-telegram-import__preview-wrap">
        <img
          className="cut-telegram-import__preview"
          src={preview.src}
          alt={preview.alt}
          onDoubleClick={() => onOpenPreview(preview)}
        />
        <Button
          type="link"
          size="small"
          className="cut-telegram-import__preview-action"
          icon={<ZoomInOutlined />}
          onClick={() => onOpenPreview(preview)}
        >
          Увеличить
        </Button>
      </div>
    );
  }
  return <Text type="secondary">{candidateScreenshotLabel(candidate) === 'нет' ? 'Нет превью' : 'Скриншот найден, превью раскроя недоступно'}</Text>;
};

interface MessageSelectionProps {
  candidate: CncTelegramImportCandidate;
  selected: boolean;
  onChange: (candidateId: string, checked: boolean) => void;
}

const MessageSelection: React.FC<MessageSelectionProps> = ({ candidate, selected, onChange }) => {
  const disabled = candidate.eligibility !== 'eligible' || candidate.sourceStatus === 'expired';
  return (
    <Checkbox
      className="cut-telegram-import__message-selection"
      checked={selected}
      disabled={disabled}
      onChange={(event) => onChange(candidate.candidateId, event.target.checked)}
      aria-label={`Выбрать SVG-комплект ${candidate.svgFileName || candidate.candidateId}`}
    >
      Выбрать комплект SVG
    </Checkbox>
  );
};

interface MessageBrowserProps {
  messages: CncTelegramImportMessage[];
  candidates: CncTelegramImportCandidate[];
  selectedIds: string[];
  viewMode: MessageViewMode;
  loading: boolean;
  onToggleCandidate: (candidateId: string, checked: boolean) => void;
  onViewModeChange: (mode: MessageViewMode) => void;
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  onPageChange: (page: number) => void;
}

const messageTypeLabel: Record<CncTelegramImportMessage['messageType'], string> = {
  svg: 'SVG',
  dxf: 'DXF',
  image: 'Фото',
  gcode: 'G-code',
  text: 'Текст',
  other: 'Вложение',
};

function messageCandidate(candidates: CncTelegramImportCandidate[], message: CncTelegramImportMessage): CncTelegramImportCandidate | null {
  return message.candidateId ? candidates.find((candidate) => candidate.candidateId === message.candidateId) ?? null : null;
}

function messageDateLabel(value: string): string {
  return new Date(value).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

const OriginalMessageFeed: React.FC<{ messages: CncTelegramImportMessage[] }> = ({ messages }) => {
  const orderedMessages = useMemo(() => sortImportMessages(messages), [messages]);
  let lastDay: string | null = null;
  return (
    <div className="cut-telegram-import__message-feed" role="list" aria-label="Сообщения Telegram в оригинальном виде">
      {orderedMessages.map((entry) => {
        const day = entry.workday || entry.sourceCreatedAt.slice(0, 10);
        const showDay = day !== lastDay;
        lastDay = day;
        const attachment = entry.messageType !== 'text';
        const content = importMessageHumanContent(entry);
        const caption = entry.messageText?.trim();
        return (
          <React.Fragment key={entry.scanMessageId}>
            {showDay && <div className="cut-telegram-import__message-day" role="presentation">{messageDateLabel(entry.sourceCreatedAt)}</div>}
            <article className={`cut-telegram-import__message-bubble ${entry.outgoing ? 'is-outgoing' : ''}`} role="listitem">
              <div className="cut-telegram-import__message-content">
                {attachment ? <Text strong>{importMessageAttachmentLabel(entry)}</Text> : <Text>{content}</Text>}
                {attachment && caption && <Text className="cut-telegram-import__message-caption">{caption}</Text>}
              </div>
              <time className="cut-telegram-import__message-time" dateTime={entry.sourceCreatedAt}>{importMessageTimeLabel(entry.sourceCreatedAt)}</time>
            </article>
          </React.Fragment>
        );
      })}
    </div>
  );
};

const TechnicalMessageCards: React.FC<Omit<MessageBrowserProps, 'viewMode' | 'onViewModeChange' | 'pagination' | 'onPageChange' | 'loading'>> = ({ messages, candidates, selectedIds, onToggleCandidate }) => {
  const orderedMessages = useMemo(() => sortImportMessages(messages), [messages]);
  return (
    <div className="cut-telegram-import__technical-cards" aria-label="Технические данные сообщений Telegram">
      {orderedMessages.map((entry) => {
        const candidate = messageCandidate(candidates, entry);
        const candidateSelectionId = eligibleCandidateIdForMessage(entry, candidates);
        return (
          <article className="cut-telegram-import__technical-card" key={entry.scanMessageId}>
            <div><Text strong>{messageTypeLabel[entry.messageType]}</Text><Text type="secondary"> · {importMessageTimeLabel(entry.sourceCreatedAt)}</Text></div>
            <Text type="secondary">ID: {entry.scanMessageId} · source: {entry.sourceMessageId}</Text>
            <Text type="secondary">Чат: {entry.sourceChatId} · thread: {entry.sourceThreadId || '—'} · ordinal: {entry.readOrdinal}</Text>
            <Text type="secondary">Файл: {entry.filename || '—'} · MIME: {entry.mimeType || '—'}</Text>
            <Text type="secondary">Ответ: {entry.replyToMessageId || '—'} · отправитель: {entry.senderUserId || '—'} · исходящее: {entry.outgoing ? 'да' : 'нет'}</Text>
            <Text type="secondary">Рабочая дата: {entry.workday} · изменено: {entry.sourceUpdatedAt ? formatDate(entry.sourceUpdatedAt) : '—'}</Text>
            <Text type="secondary">Кандидат: {entry.candidateId || '—'} · роль: {entry.candidateRole || '—'}</Text>
            {entry.messageText && <Text className="cut-telegram-import__technical-text">Текст: {entry.messageText}</Text>}
            {candidateSelectionId && candidate && <MessageSelection candidate={candidate} selected={selectedIds.includes(candidateSelectionId)} onChange={onToggleCandidate} />}
          </article>
        );
      })}
    </div>
  );
};

const TechnicalMessageTable: React.FC<Omit<MessageBrowserProps, 'viewMode' | 'onViewModeChange' | 'pagination' | 'onPageChange' | 'loading'>> = ({ messages, candidates, selectedIds, onToggleCandidate }) => {
  const orderedMessages = useMemo(() => sortImportMessages(messages), [messages]);
  const columns: ColumnsType<CncTelegramImportMessage> = [
    { title: 'Время', key: 'time', width: 150, render: (_value, entry) => <time dateTime={entry.sourceCreatedAt}>{formatDate(entry.sourceCreatedAt)}</time> },
    { title: 'ID', key: 'id', width: 180, render: (_value, entry) => <Text copyable={{ text: entry.scanMessageId }}>{entry.scanMessageId}</Text> },
    { title: 'Тип', key: 'type', width: 90, render: (_value, entry) => messageTypeLabel[entry.messageType] },
    { title: 'Файл / MIME', key: 'file', width: 220, render: (_value, entry) => <span>{entry.filename || '—'}<br /><Text type="secondary">{entry.mimeType || '—'}</Text></span> },
    { title: 'Текст', key: 'text', width: 240, render: (_value, entry) => <span className="cut-telegram-import__technical-text">{entry.messageText || '—'}</span> },
    { title: 'Источник и связи', key: 'links', width: 310, render: (_value, entry) => <span>chat: {entry.sourceChatId} · source: {entry.sourceMessageId}<br />thread: {entry.sourceThreadId || '—'} · reply: {entry.replyToMessageId || '—'}<br />sender: {entry.senderUserId || '—'} · outgoing: {entry.outgoing ? 'да' : 'нет'} · ordinal: {entry.readOrdinal}<br />workday: {entry.workday} · updated: {entry.sourceUpdatedAt ? formatDate(entry.sourceUpdatedAt) : '—'}</span> },
    { title: 'Кандидат', key: 'candidate', width: 220, render: (_value, entry) => {
      const candidate = messageCandidate(candidates, entry);
      const candidateSelectionId = eligibleCandidateIdForMessage(entry, candidates);
      return <span>{entry.candidateId || '—'} · {entry.candidateRole || '—'}{candidateSelectionId && candidate ? <MessageSelection candidate={candidate} selected={selectedIds.includes(candidateSelectionId)} onChange={onToggleCandidate} /> : null}</span>;
    } },
  ];
  return (
    <>
      <div className="cut-telegram-import__technical-table-desktop">
        <Table<CncTelegramImportMessage> rowKey="scanMessageId" size="small" columns={columns} dataSource={orderedMessages} pagination={false} scroll={{ x: 1310 }} />
      </div>
      <TechnicalMessageCards messages={orderedMessages} candidates={candidates} selectedIds={selectedIds} onToggleCandidate={onToggleCandidate} />
    </>
  );
};

const MessageBrowser: React.FC<MessageBrowserProps> = ({ messages, candidates, selectedIds, viewMode, loading, onToggleCandidate, onViewModeChange, pagination, onPageChange }) => (
  <section className="cut-telegram-import__message-browser" aria-live="polite">
    <div className="cut-telegram-import__message-browser-header">
      <div>
        <Text strong>Все сообщения выбранного периода</Text>
        <Text type="secondary"> · {pagination.total || messages.length}</Text>
      </div>
      <div aria-label="Режим просмотра сообщений Telegram">
        <Tabs
          className="cut-telegram-import__message-tabs"
          activeKey={viewMode}
          onChange={(value) => { if (value === 'original' || value === 'technical') onViewModeChange(value); }}
          items={[{ key: 'original', label: 'Оригинальный' }, { key: 'technical', label: 'Технический' }]}
        />
      </div>
    </div>
    {loading ? <div className="cut-telegram-import__message-loading"><Spin /></div> : messages.length === 0 ? <Empty description="Сообщений за период не найдено" /> : viewMode === 'original' ? (
      <OriginalMessageFeed messages={messages} />
    ) : (
      <TechnicalMessageTable messages={messages} candidates={candidates} selectedIds={selectedIds} onToggleCandidate={onToggleCandidate} />
    )}
    {pagination.total > pagination.pageSize && <Pagination className="cut-telegram-import__message-pagination" current={pagination.page} pageSize={pagination.pageSize} total={pagination.total} showSizeChanger={false} showTotal={(total) => `Всего: ${total}`} onChange={onPageChange} aria-label="Страницы сообщений Telegram" />}
  </section>
);

export const CutTelegramImportModal: React.FC<CutTelegramImportModalProps> = ({ open, onClose, onDone }) => {
  const [step, setStep] = useState<ImportStep>(0);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [messageView, setMessageView] = useState<MessageViewMode>('original');
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [repeatOfRequestId, setRepeatOfRequestId] = useState<string | null>(null);
  const [requestedNumbers, setRequestedNumbers] = useState<Record<string, number | null>>({});
  const [reconfirming, setReconfirming] = useState(false);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const doneRequestRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (!open) setPreview(null);
  }, [open]);

  const {
    scan,
    candidates,
    messages,
    messagePagination,
    importRequest,
    prepared,
    loadingCandidates,
    loadingMessages,
    error,
    startScan,
    prepareImport,
    confirmImport,
    reconfirmImport,
    prepareRepeat,
    returnToSelection,
    loadMessages,
  } = useCncTelegramImport(open);
  const canImport = featureFlags.cncTelegram && can('cut.manage');
  const numberChecks = useCutJobNumberChecks(selectedIds, requestedNumbers, open && step === 1);

  useEffect(() => {
    if (!open) return;
    // The readable chat view is always the safe default for a fresh open or scan.
    // Deliberately do not persist this preference alongside active scan state.
    setMessageView('original');
  }, [open, scan?.scanId]);

  useEffect(() => {
    if (!open) return;
    if (scan?.status === 'ready' && !importRequest) setStep(1);
    if (prepared && !importRequest) setStep(2);
    if (importRequest) setStep(2);
  }, [candidates.length, importRequest, open, prepared, scan?.status]);

  useEffect(() => {
    if (!importRequest || !['completed', 'partial', 'failed'].includes(importRequest.status) || doneRequestRef.current === importRequest.importRequestId) return;
    doneRequestRef.current = importRequest.importRequestId;
    onDone?.();
  }, [importRequest, onDone]);

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => candidates.some((candidate) => candidate.candidateId === id)));
  }, [candidates]);

  const selectedCandidates = useMemo(
    () => candidates
      .filter((candidate) => selectedIds.includes(candidate.candidateId))
      .map((candidate) => {
        const refreshedMatches = prepared?.refreshedMatches?.[candidate.candidateId];
        return refreshedMatches ? { ...candidate, matches: refreshedMatches } : candidate;
      }),
    [candidates, prepared?.refreshedMatches, selectedIds],
  );
  const selectedDuplicateCount = prepared?.duplicateCount ?? selectedCandidates.filter(candidateDuplicate).length;
  const selectionReady = selectedIds.length > 0 && selectedCandidates.length === selectedIds.length;
  const progressPercent = scan?.progress.daysTotal > 0
    ? Math.min(100, Math.round((scan.progress.daysProcessed / scan.progress.daysTotal) * 100))
    : scan?.status === 'ready' ? 100 : 0;

  const tableRowSelection: TableProps<CncTelegramImportCandidate>['rowSelection'] = {
    selectedRowKeys: selectedIds,
    onChange: (keys) => { if (!preparing) setSelectedIds(Array.from(new Set(keys.map(String)))); },
    getCheckboxProps: (record) => ({ disabled: record.eligibility !== 'eligible' || record.sourceStatus === 'expired' }),
  };

  const toggleCandidateSelection = (candidateId: string, checked: boolean) => {
    if (preparing) return;
    setSelectedIds((current) => checked
      ? (current.includes(candidateId) ? current : [...current, candidateId])
      : current.filter((id) => id !== candidateId));
  };

  const columns: ColumnsType<CncTelegramImportCandidate> = [
    {
      title: 'Файл и источник',
      key: 'file',
      render: (_value, candidate) => <CandidateDetails candidate={candidate} />,
    },
    {
      title: 'Номер задания',
      key: 'number',
      width: 230,
      render: (_value, candidate) => {
        const check = numberChecks.checks[candidate.candidateId];
        return (
          <Space direction="vertical" size={4}>
            <InputNumber
              aria-label={`Номер задания для ${candidate.svgFileName}`}
              placeholder="Авто"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              controls={false}
              value={requestedNumbers[candidate.candidateId] ?? null}
              status={check?.status === 'error' ? 'error' : undefined}
              disabled={!canImport || preparing || candidate.eligibility !== 'eligible' || candidate.sourceStatus === 'expired'}
              onChange={(value) => setRequestedNumbers((current) => ({ ...current, [candidate.candidateId]: value }))}
              style={{ width: '100%' }}
            />
            {check && <Text type={check.status === 'error' ? 'danger' : 'secondary'}>{check.message}</Text>}
            {check?.suggestions?.length ? (
              <Space size={4} wrap>
                {check.suggestions.map((number) => (
                  <Button key={number} size="small" disabled={preparing} onClick={() => setRequestedNumbers((current) => ({ ...current, [candidate.candidateId]: number }))}>
                    №{number}
                  </Button>
                ))}
              </Space>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: 'Превью',
      key: 'preview',
      width: 150,
      render: (_value, candidate) => <CandidatePreview candidate={candidate} onOpenPreview={setPreview} />,
    },
  ];

  const dateDisabled = (current: Dayjs): boolean => {
    if (!range) return false;
    const other = current.isBefore(range[0], 'day') ? range[1] : range[0];
    return other ? Math.abs(current.diff(other, 'day')) >= MAX_SCAN_DAYS : false;
  };

  const handleStartScan = async () => {
    if (!canImport) return;
    const days = range[1].startOf('day').diff(range[0].startOf('day'), 'day') + 1;
    if (days < 1 || days > MAX_SCAN_DAYS) {
      message.warning(`Период должен быть от 1 до ${MAX_SCAN_DAYS} календарных дней`);
      return;
    }
    try {
      setSelectedIds([]);
      setRequestedNumbers({});
      setRepeatOfRequestId(null);
      setMessageView('original');
      await startScan({ dateFrom: range[0].format('YYYY-MM-DD'), dateTo: range[1].format('YYYY-MM-DD') });
    } catch (nextError) {
      message.error(nextError instanceof ApiError ? nextError.message : 'Не удалось запустить поиск в Telegram');
    }
  };

  const handlePrepare = async () => {
    if (!canImport) return;
    if (selectedIds.length === 0) {
      message.warning('Выберите хотя бы один комплект');
      return;
    }
    if (!numberChecks.ready) return;
    setPreparing(true);
    try {
      const requestedCutJobIds = Object.fromEntries(selectedIds
        .filter((id) => requestedNumbers[id] != null)
        .map((id) => [id, requestedNumbers[id]!]));
      if (repeatOfRequestId) {
        await prepareRepeat(repeatOfRequestId, selectedIds, requestedCutJobIds);
      } else {
        await prepareImport(selectedIds, requestedCutJobIds);
      }
      setStep(2);
    } catch (nextError) {
      message.error(nextError instanceof ApiError ? nextError.message : 'Не удалось подготовить импорт');
    } finally {
      setPreparing(false);
    }
  };

  const handleConfirm = async () => {
    if (!canImport) return;
    if (!prepared || !selectionReady) return;
    setConfirming(true);
    try {
      await confirmImport(selectedCandidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        duplicateAcknowledged: candidateDuplicate(candidate),
      })));
      message.success('Импорт поставлен в обработку');
    } catch (nextError) {
      message.error(nextError instanceof ApiError ? nextError.message : 'Не удалось подтвердить импорт');
    } finally {
      setConfirming(false);
    }
  };

  const handleRepeat = async () => {
    if (!importRequest || importRequest.items.length === 0) return;
    const items = repeatableItems(importRequest);
    if (items.length === 0) {
      message.info('Нет элементов, доступных для повторной обработки');
      return;
    }
    setRepeatOfRequestId(importRequest.importRequestId);
    setRequestedNumbers(importRequest.status === 'completed' ? {} : Object.fromEntries(
      items.map((item) => [item.candidateId, item.requestedCutJobId ?? null]),
    ));
    setSelectedIds(items.map((item) => item.candidateId));
    returnToSelection();
    setMessageView('original');
    setStep(1);
  };

  const handleMessagePageChange = (page: number) => {
    if (scan) void loadMessages(scan.scanId, page);
  };

  const handleReconfirm = async () => {
    if (!importRequest || !needsDuplicateReconfirmation(importRequest)) return;
    setReconfirming(true);
    try {
      const next = await reconfirmImport(importRequest);
      if (next.items.some((item) => item.status === 'confirmation_required')) {
        message.warning('Сервер ещё ожидает повторное подтверждение. Состояние продолжит обновляться автоматически.');
      } else {
        message.success('Повторное подтверждение отправлено');
      }
    } catch (nextError) {
      message.error(nextError instanceof ApiError ? nextError.message : 'Не удалось повторно подтвердить импорт');
    } finally {
      setReconfirming(false);
    }
  };

  const footer = step === 0 ? [
    <Button key="close" onClick={onClose}>Закрыть</Button>,
    <Button key="scan" type="primary" icon={<SearchOutlined />} onClick={() => void handleStartScan()} disabled={!canImport} loading={scan?.status === 'pending' || scan?.status === 'processing'}>
      Найти файлы
    </Button>,
  ] : step === 1 ? [
    <Button key="back" onClick={() => setStep(0)} disabled={preparing}>Изменить период</Button>,
    <Button key="prepare" type="primary" onClick={() => void handlePrepare()} loading={preparing} disabled={!canImport || selectedIds.length === 0 || !numberChecks.ready}>Подготовить создание ({selectedIds.length})</Button>,
  ] : [
    <Button key="back" onClick={() => { returnToSelection(); setStep(1); }} disabled={confirming || Boolean(importRequest)}>Вернуться к выбору</Button>,
    <Button key="confirm" type="primary" danger={selectedDuplicateCount > 0} icon={<CheckCircleOutlined />} onClick={() => void handleConfirm()} loading={confirming} disabled={!canImport || Boolean(importRequest) || !selectionReady}>
      {selectedDuplicateCount > 0 ? 'Создать всё равно' : 'Создать выбранные'}
    </Button>,
  ];

  return (
    <>
      <Modal
      className="cut-telegram-import-modal"
      title={<Space><SendOutlined /> Импорт раскроев из Telegram</Space>}
      open={open}
      onCancel={onClose}
      width={1040}
      footer={footer}
    >
      <Steps current={step} items={[{ title: 'Поиск в Telegram' }, { title: 'Найденные комплекты' }, { title: 'Подтверждение и результат' }]} />
      {error && <Alert className="cut-telegram-import__alert" type="error" showIcon message="Не удалось обновить состояние импорта" description={error instanceof Error ? error.message : 'Повторите действие позже.'} />}

      {step === 0 && (
        <div className="cut-telegram-import__step">
          <Paragraph type="secondary">Фоновое сканирование отключено. Этот поиск читает только выбранный период и не создаёт задания до вашего подтверждения.</Paragraph>
          <Space wrap className="cut-telegram-import__presets">
            {[1, 3, 7, 14].map((days) => (
              <Button key={days} onClick={() => setRange([dayjs().subtract(days - 1, 'day').startOf('day'), dayjs().endOf('day')])} type={range[1].diff(range[0], 'day') + 1 === days ? 'primary' : 'default'}>
                {days === 1 ? 'Сегодня' : `${days} дня`}
              </Button>
            ))}
          </Space>
          <DatePicker.RangePicker
            value={range}
            onChange={(next) => { if (next?.[0] && next?.[1]) setRange([next[0].startOf('day'), next[1].endOf('day')]); }}
            disabledDate={dateDisabled}
            allowClear={false}
            format="DD.MM.YYYY"
          />
          <Text type="secondary">Максимум {MAX_SCAN_DAYS} календарных дней. Часовой пояс: {scan?.businessTimezone ?? 'настроенный CNC'}.</Text>
          {scan && (scan.status === 'pending' || scan.status === 'processing') && (
            <CardlessProgress scan={scan} percent={progressPercent} />
          )}
          {scan?.status === 'failed' && <Alert type="error" showIcon message="Поиск завершился ошибкой" description={scan.error ?? 'Безопасное описание ошибки недоступно.'} />}
        </div>
      )}

      {step === 1 && (
        <div className="cut-telegram-import__step">
          <div className="cut-telegram-import__summary">
            <Text strong>Сообщений: {messagePagination.total || messages.length}</Text>
            <Text>SVG-комплектов: {candidates.length}</Text>
            <Text type="secondary">Выбрано: {selectedIds.length}</Text>
            <Text type="warning">С предупреждением: {candidates.filter(candidateDuplicate).length}</Text>
          </div>
          {scan?.progress.truncated && <Alert type="warning" showIcon message="Результат ограничен" description="Достигнут лимит сообщений или SVG-комплектов. Уточните период для полного результата." />}
          <MessageBrowser
            messages={messages}
            candidates={candidates}
            selectedIds={selectedIds}
            viewMode={messageView}
            loading={loadingMessages}
            onToggleCandidate={toggleCandidateSelection}
            onViewModeChange={setMessageView}
            pagination={messagePagination}
            onPageChange={handleMessagePageChange}
          />
          <section className="cut-telegram-import__candidate-picker" aria-label="Выбор SVG-комплектов">
            <Paragraph type="secondary">Номер можно задать вручную, в том числе освободившийся после удаления задания. Пустое поле — автоматический номер.</Paragraph>
            {Object.values(numberChecks.checks).some((check) => check.status === 'error') && (
              <Button size="small" onClick={numberChecks.retry}>Повторить проверку номеров</Button>
            )}
            <div className="cut-telegram-import__candidate-picker-header">
              <div>
                <Text strong>Комплекты для создания</Text>
                <Text type="secondary"> · отметьте SVG-комплекты, которые нужно импортировать</Text>
              </div>
              {loadingCandidates && <Spin size="small" />}
            </div>
            {candidates.length === 0 ? <Empty description="Подходящих SVG-комплектов не найдено" /> : (
              <Table<CncTelegramImportCandidate>
                rowKey="candidateId"
                rowSelection={tableRowSelection}
                columns={columns}
                dataSource={candidates}
                pagination={{ pageSize: 20, showSizeChanger: false }}
                scroll={{ x: 760 }}
              />
            )}
          </section>
        </div>
      )}

      {step === 2 && (
        <div className="cut-telegram-import__step">
          {importRequest ? <ImportResult request={importRequest} candidates={candidates} onRepeat={() => void handleRepeat()} repeatLoading={false} onReconfirm={() => void handleReconfirm()} reconfirmLoading={reconfirming} /> : prepared ? (
            <>
              <Alert
                type={selectedDuplicateCount > 0 ? 'warning' : 'info'}
                showIcon
                message={selectedDuplicateCount > 0 ? 'Будут созданы новые задания, несмотря на найденные похожие раскрои' : 'Проверьте выбор перед созданием'}
                description={`Выбрано ${selectedIds.length}. Новых: ${selectedIds.length - selectedDuplicateCount}. С похожими: ${selectedDuplicateCount}.`}
              />
              <Paragraph type="secondary">Это явное подтверждение. Повторный клик безопасен: сервер сохранит один результат для этого подтверждения.</Paragraph>
              <Space direction="vertical" className="cut-telegram-import__confirm-list">
                {selectedCandidates.map((candidate) => (
                  <div key={candidate.candidateId}>
                    <CandidateDetails candidate={candidate} />
                    <Text strong>Номер задания: {prepared.items?.find((item) => item.candidateId === candidate.candidateId)?.requestedCutJobId ?? 'Автоматически'}</Text>
                  </div>
                ))}
              </Space>
            </>
          ) : <Spin />}
        </div>
      )}
      </Modal>
      <PreviewLightbox preview={preview} onClose={() => setPreview(null)} />
    </>
  );
};

const CardlessProgress: React.FC<{ scan: CncTelegramImportScan; percent: number }> = ({ scan, percent }) => (
  <div className="cut-telegram-import__progress">
    <Text>Поиск выполняется… {scan.progress.daysProcessed}/{scan.progress.daysTotal || '—'} дней</Text>
    <Progress percent={percent} status="active" />
    <Text type="secondary">Сообщения: {scan.progress.messagesProcessed}/{scan.progress.messagesTotal || '—'} · кандидаты: {scan.progress.candidatesTotal}</Text>
  </div>
);

const ImportResult: React.FC<{ request: NonNullable<ReturnType<typeof useCncTelegramImport>['importRequest']>; candidates: CncTelegramImportCandidate[]; onRepeat: () => void; repeatLoading: boolean; onReconfirm: () => void; reconfirmLoading: boolean }> = ({ request, candidates, onRepeat, repeatLoading, onReconfirm, reconfirmLoading }) => (
  <div className="cut-telegram-import__result">
    <Alert
      type={request.status === 'completed' ? 'success' : request.status === 'partial' ? 'warning' : request.status === 'failed' ? 'error' : needsDuplicateReconfirmation(request) ? 'warning' : 'info'}
      showIcon
      message={request.status === 'completed' ? 'Импорт завершён' : request.status === 'partial' ? 'Импорт завершён частично' : request.status === 'failed' ? 'Импорт завершился ошибкой' : needsDuplicateReconfirmation(request) ? 'Нужно повторное подтверждение' : 'Импорт выполняется'}
      description={`${request.importedCount}/${request.totalCount} создано · ошибок: ${request.failedCount}`}
    />
    <Space direction="vertical" className="cut-telegram-import__result-list">
      {request.items.map((item) => (
        <div className="cut-telegram-import__result-item" key={item.importItemId}>
          <Space><Tag color={item.status === 'imported' ? 'success' : item.status === 'failed' ? 'error' : 'processing'}>{itemStatusLabel(item.status)}</Tag><Text strong>{item.svgFileName || candidates.find((candidate) => candidate.candidateId === item.candidateId)?.svgFileName || item.candidateId}</Text></Space>
          {item.cutJobId && <a href={`/cut?job=${item.cutJobId}`}>Раскрой {item.cutJobDisplayNumber ?? item.requestedCutJobId ?? `#${item.cutJobId}`} <LinkOutlined /></a>}
          {item.error && <Text type="danger">{item.error}</Text>}
        </div>
      ))}
    </Space>
    {needsDuplicateReconfirmation(request) && (
      <Button onClick={onReconfirm} loading={reconfirmLoading}>Повторно подтвердить создание</Button>
    )}
    {(request.status === 'completed' || request.status === 'partial' || request.status === 'failed') && (
      <Button onClick={onRepeat} loading={repeatLoading}>{request.status === 'completed' ? 'Создать ещё одну копию' : 'Повторить ошибки'}</Button>
    )}
  </div>
);
