import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, DatePicker, Empty, Modal, Progress, Space, Spin, Steps, Tag, Typography, message } from 'antd';
import type { ColumnsType, TableProps } from 'antd/es/table';
import { CheckCircleOutlined, ExclamationCircleOutlined, LinkOutlined, SearchOutlined, SendOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { ApiError } from '../../api/httpClient';
import { can } from '../../utils/permissions';
import { featureFlags } from '../../config/featureFlags';
import { useCncTelegramImport } from '../../hooks/useCncTelegramImport';
import type { CncTelegramImportCandidate, CncTelegramImportItem, CncTelegramImportMatch, CncTelegramImportScan } from '../../api/types/cncTelegramImportApi.types';
import { needsDuplicateReconfirmation, repeatableItems } from './cutTelegramImportHelpers';
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

const CandidateDetails: React.FC<{ candidate: CncTelegramImportCandidate }> = ({ candidate }) => (
  <div className="cut-telegram-import__candidate-details">
    <div className="cut-telegram-import__file-line">
      <Text strong>{candidate.svgFileName}</Text>
      <Tag color={candidateDuplicate(candidate) ? 'warning' : 'default'}>{sourceStatusLabel(candidate.sourceStatus)}</Tag>
    </div>
    <Text type="secondary">{formatDate(candidate.sourceCreatedAt)} · {candidate.sheetCount ?? '—'} листов · {candidate.positionCount ?? '—'} позиций</Text>
    <Text type="secondary">
      G-code: {candidate.gcodeFileName ?? 'нет'} · скриншот: {candidate.screenshotFileName ?? 'нет'}
    </Text>
    {(candidate.sheetWidthMm || candidate.sheetHeightMm) && (
      <Text type="secondary">Лист: {candidate.sheetWidthMm ?? '—'} × {candidate.sheetHeightMm ?? '—'} мм</Text>
    )}
    {candidate.orderLabels && candidate.orderLabels.length > 0 && <Text type="secondary">Заказы: {candidate.orderLabels.join(', ')}</Text>}
    {candidate.parserWarnings.length > 0 && <Text type="warning">Предупреждения парсера: {candidate.parserWarnings.join('; ')}</Text>}
    <DuplicateMatches matches={candidate.matches} />
  </div>
);

export const CutTelegramImportModal: React.FC<CutTelegramImportModalProps> = ({ open, onClose, onDone }) => {
  const [step, setStep] = useState<ImportStep>(0);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(defaultRange);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [repeatPreparing, setRepeatPreparing] = useState(false);
  const [reconfirming, setReconfirming] = useState(false);
  const doneRequestRef = React.useRef<string | null>(null);
  const {
    scan,
    candidates,
    importRequest,
    prepared,
    loadingCandidates,
    error,
    startScan,
    prepareImport,
    confirmImport,
    reconfirmImport,
    prepareRepeat,
  } = useCncTelegramImport(open);
  const canImport = featureFlags.cncTelegram && can('cut.manage');

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
    onChange: (keys) => setSelectedIds(keys as string[]),
    getCheckboxProps: (record) => ({ disabled: record.eligibility !== 'eligible' || record.sourceStatus === 'expired' }),
  };

  const columns: ColumnsType<CncTelegramImportCandidate> = [
    {
      title: 'Файл и источник',
      key: 'file',
      render: (_value, candidate) => <CandidateDetails candidate={candidate} />,
    },
    {
      title: 'Превью',
      key: 'preview',
      width: 150,
      render: (_value, candidate) => candidate.previewUrl ? (
        <img className="cut-telegram-import__preview" src={candidate.previewUrl} alt={`Превью ${candidate.svgFileName}`} />
      ) : <Text type="secondary">Нет превью</Text>,
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
    setPreparing(true);
    try {
      await prepareImport(selectedIds);
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
    setRepeatPreparing(true);
    try {
      const next = await prepareRepeat(importRequest.importRequestId, items.map((item) => item.candidateId));
      setSelectedIds(items.map((item) => item.candidateId));
      setStep(2);
      if (next.duplicateCount > 0) message.warning('Появились совпадения. Подтвердите создание копии ещё раз.');
    } catch (nextError) {
      message.error(nextError instanceof ApiError ? nextError.message : 'Не удалось подготовить повторную копию');
    } finally {
      setRepeatPreparing(false);
    }
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
    <Button key="back" onClick={() => setStep(0)}>Изменить период</Button>,
    <Button key="prepare" type="primary" onClick={() => void handlePrepare()} loading={preparing} disabled={!canImport || selectedIds.length === 0}>Подготовить создание ({selectedIds.length})</Button>,
  ] : [
    <Button key="back" onClick={() => setStep(1)} disabled={confirming || Boolean(importRequest)}>Вернуться к выбору</Button>,
    <Button key="confirm" type="primary" danger={selectedDuplicateCount > 0} icon={<CheckCircleOutlined />} onClick={() => void handleConfirm()} loading={confirming} disabled={!canImport || Boolean(importRequest) || !selectionReady}>
      {selectedDuplicateCount > 0 ? 'Создать всё равно' : 'Создать выбранные'}
    </Button>,
  ];

  return (
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
          <div className="cut-telegram-import__summary"><Text strong>Найдено: {candidates.length}</Text><Text type="secondary">Выбрано: {selectedIds.length}</Text><Text type="warning">С предупреждением: {candidates.filter(candidateDuplicate).length}</Text></div>
          {scan?.progress.truncated && <Alert type="warning" showIcon message="Результат ограничен" description="Telegram вернул больше сообщений, чем разрешено для одного поиска. Уточните период для полного результата." />}
          {loadingCandidates ? <Spin /> : candidates.length === 0 ? <Empty description="Подходящих SVG-комплектов не найдено" /> : (
            <Table<CncTelegramImportCandidate>
              rowKey="candidateId"
              rowSelection={tableRowSelection}
              columns={columns}
              dataSource={candidates}
              pagination={{ pageSize: 20, showSizeChanger: false }}
              scroll={{ x: 760 }}
            />
          )}
        </div>
      )}

      {step === 2 && (
        <div className="cut-telegram-import__step">
          {importRequest ? <ImportResult request={importRequest} candidates={candidates} onRepeat={() => void handleRepeat()} repeatLoading={repeatPreparing} onReconfirm={() => void handleReconfirm()} reconfirmLoading={reconfirming} /> : prepared ? (
            <>
              <Alert
                type={selectedDuplicateCount > 0 ? 'warning' : 'info'}
                showIcon
                message={selectedDuplicateCount > 0 ? 'Будут созданы новые задания, несмотря на найденные похожие раскрои' : 'Проверьте выбор перед созданием'}
                description={`Выбрано ${selectedIds.length}. Новых: ${selectedIds.length - selectedDuplicateCount}. С похожими: ${selectedDuplicateCount}.`}
              />
              <Paragraph type="secondary">Это явное подтверждение. Повторный клик безопасен: сервер сохранит один результат для этого подтверждения.</Paragraph>
              <Space direction="vertical" className="cut-telegram-import__confirm-list">
                {selectedCandidates.map((candidate) => <CandidateDetails key={candidate.candidateId} candidate={candidate} />)}
              </Space>
            </>
          ) : <Spin />}
        </div>
      )}
    </Modal>
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
          {item.cutJobId && <a href={`/cut?job=${item.cutJobId}`}>Раскрой {item.cutJobDisplayNumber ?? `#${item.cutJobId}`} <LinkOutlined /></a>}
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
