import { Tooltip } from '../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Button, Checkbox, Form, Input, InputNumber, Modal, Select, Slider, Space, Tag, Typography, Upload, message } from 'antd';
import type { UploadProps } from 'antd';
import {
  CloseOutlined,
  FileAddOutlined,
  FullscreenOutlined,
  LinkOutlined,
  MinusOutlined,
  PrinterOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { cutApi } from '../../api/cutApi';
import { ordersApi } from '../../api/ordersApi';
import { isApiError, type ApiError } from '../../api/apiError';
import type {
  CncTelegramManualSvgCommentPreset,
  CncTelegramManualSvgUploadFile,
  CncTelegramManualSvgUploadFileKind,
  CncTelegramManualSvgUploadRequest,
} from '../../api/types/cncTelegramApi.types';
import type { EligibleDetailDto } from '../../api/types/cutApi.types';
import type { OrderListItemDto } from '../../api/types/orderApi.types';
import { parseSvgCutUploadFileNameHints } from './svgCutUploadFilename';
import { parseSvgCutUploadFile, type ParsedSvgUpload } from './svgCutUploadParser';
import { createRawSvgUploadPreviewBlob } from './svgCutRenderPreview';

interface CutSvgUploadModalProps {
  open: boolean;
  onClose: () => void;
  onDone?: (cutJobId: number | null) => void;
  defaultOrderIds?: number[];
  defaultOrderNames?: string[];
}

interface OrderOption {
  value: number;
  label: string;
}

interface CutJobNumberCheck {
  status: 'idle' | 'checking' | 'available' | 'duplicate' | 'error';
  suggestions: number[];
  message?: string;
}

interface SvgMatchProblem {
  severity: 'error' | 'warning';
  key: string;
  title: string;
  reason: string;
  quantity: number;
}

interface SvgItemGroup {
  orderName: string;
  detailNumber: number;
  widthMm: number;
  heightMm: number;
  quantity: number;
}

interface SvgPreviewState {
  url: string;
  fileName: string;
}

interface ManualSvgUploadFileState {
  payload: CncTelegramManualSvgUploadFile;
  selectedAt: number;
}

type SvgUploadMatchMode = 'order_details' | 'informational';
type SvgCommentPresetOption = Pick<CncTelegramManualSvgCommentPreset, 'label' | 'commentText' | 'category'>;
type FloatingSvgPreviewResizeCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
interface FloatingSvgPreviewRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const EMPTY_DEFAULT_ORDER_IDS: number[] = [];
const EMPTY_DEFAULT_ORDER_NAMES: string[] = [];
const EMPTY_CUT_JOB_NUMBER_CHECK: CutJobNumberCheck = { status: 'idle', suggestions: [] };
const FLOATING_SVG_PREVIEW_MARGIN = 16;
const FLOATING_SVG_PREVIEW_MIN_WIDTH = 360;
const FLOATING_SVG_PREVIEW_MIN_HEIGHT = 320;
const FLOATING_SVG_PREVIEW_DEFAULT_WIDTH = 760;
const FLOATING_SVG_PREVIEW_DEFAULT_HEIGHT = 620;
const MANUAL_SVG_UPLOAD_MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT = 1.45;
const MANUAL_SVG_SCREENSHOT_CONTRAST_MIN = 1;
const MANUAL_SVG_SCREENSHOT_CONTRAST_MAX = 6;
const MANUAL_SVG_SCREENSHOT_CONTRAST_STEP = 0.05;

const DEFAULT_COMMENT_PRESETS: SvgCommentPresetOption[] = [
  { label: 'Фрезы', commentText: 'фрезы:', category: 'tool' },
  { label: 'Фрезы ХДФ', commentText: 'Фрезы для ХДФ: 8', category: 'tool' },
  { label: 'Фрезы ЛДСП', commentText: 'Фрезы для ЛДСП: 8', category: 'tool' },
  { label: 'Фрезы 18мм', commentText: 'Фрезы для 18мм:', category: 'tool' },
  { label: 'Фрезы 10мм', commentText: 'Фрезы для 10мм:', category: 'tool' },
  { label: 'Фреза лам. стороны', commentText: 'Фреза для ламинированной стороны:', category: 'tool' },
  { label: 'Материал', commentText: 'материал:', category: 'material' },
  { label: 'Ламинированная сторона МДФ', commentText: 'Ламинированная сторона МДФ !!!', category: 'material' },
  { label: 'Черновой', commentText: 'Черновой', category: 'general' },
  { label: 'Черновой 2 стороны', commentText: 'Черновой с двух сторон!!!', category: 'general' },
  { label: 'Присадка №', commentText: 'Присадка №', category: 'general' },
  { label: 'Переделка', commentText: 'переделка', category: 'rework' },
];

export const CutSvgUploadModal: React.FC<CutSvgUploadModalProps> = ({
  open,
  onClose,
  onDone,
  defaultOrderIds = EMPTY_DEFAULT_ORDER_IDS,
  defaultOrderNames = EMPTY_DEFAULT_ORDER_NAMES,
}) => {
  const navigate = useNavigate();
  const defaultOrderIdsKey = defaultOrderIds.join(',');
  const defaultOrderNamesKey = defaultOrderNames.join('\u001f');
  const defaultOrderOptions = useMemo(() => defaultOrderIds.map((orderId, index) => ({
    value: orderId,
    label: formatDefaultOrderOptionLabel(orderId, defaultOrderNames[index]),
  })), [defaultOrderIdsKey, defaultOrderNamesKey]);
  const [parsed, setParsed] = useState<ParsedSvgUpload | null>(null);
  const [svgPreview, setSvgPreview] = useState<SvgPreviewState | null>(null);
  const [svgPreviewExpanded, setSvgPreviewExpanded] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const svgPreviewUrlRef = useRef<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [lenientValidation, setLenientValidation] = useState(true);
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>(defaultOrderIds);
  const [orderOptions, setOrderOptions] = useState<OrderOption[]>(defaultOrderOptions);
  const [orderSearchLoading, setOrderSearchLoading] = useState(false);
  const [eligibleDetails, setEligibleDetails] = useState<EligibleDetailDto[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [telegramMessage, setTelegramMessage] = useState('');
  const [sendToTelegram, setSendToTelegram] = useState(true);
  const [svgSourceFile, setSvgSourceFile] = useState<ManualSvgUploadFileState | null>(null);
  const [gcodeSourceFile, setGcodeSourceFile] = useState<ManualSvgUploadFileState | null>(null);
  const [screenshotSourceFile, setScreenshotSourceFile] = useState<ManualSvgUploadFileState | null>(null);
  const [generatedScreenshotContrast, setGeneratedScreenshotContrast] = useState(MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT);
  const [materialName, setMaterialName] = useState('');
  const [machineName, setMachineName] = useState('');
  const [requestedCutJobId, setRequestedCutJobId] = useState<number | null>(null);
  const [cutJobNumberCheck, setCutJobNumberCheck] = useState<CutJobNumberCheck>(EMPTY_CUT_JOB_NUMBER_CHECK);
  const [rework, setRework] = useState(false);
  const [presets, setPresets] = useState<CncTelegramManualSvgCommentPreset[]>([]);
  const [presetSaving, setPresetSaving] = useState(false);
  const uploadMatchMode: SvgUploadMatchMode = useMemo(
    () => svgUploadMaterialIsInformational(materialName, parsed?.fileName ?? null)
      ? 'informational'
      : 'order_details',
    [materialName, parsed?.fileName],
  );
  const informationalUpload = uploadMatchMode === 'informational';

  useEffect(() => {
    if (!open) return;
    setMinimized(false);
    setSelectedOrderIds(defaultOrderIds);
    setOrderOptions(defaultOrderOptions);
  }, [defaultOrderIdsKey, defaultOrderOptions, open]);

  useEffect(() => {
    if (!open) return;
    cncTelegramApi.listManualSvgCommentPresets()
      .then(setPresets)
      .catch(() => setPresets([]));
  }, [open]);

  useEffect(() => {
    if (!open || informationalUpload || selectedOrderIds.length === 0 || !parsed?.cutLayout.items.length) {
      setEligibleDetails([]);
      return;
    }
    let cancelled = false;
    setEligibleLoading(true);
    cutApi.listEligibleDetailsPreview({ orderIds: selectedOrderIds })
      .then((response) => {
        if (!cancelled) setEligibleDetails(response.details);
      })
      .catch(() => {
        if (!cancelled) setEligibleDetails([]);
      })
      .finally(() => {
        if (!cancelled) setEligibleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [informationalUpload, open, parsed, selectedOrderIds]);

  const orderPresetText = useMemo(() => {
    const labels = selectedOrderIds
      .map((orderId) => orderOptions.find((option) => option.value === orderId)?.label ?? formatDefaultOrderOptionLabel(orderId, null));
    return labels.length > 0 ? `весь заказ: ${labels.join(', ')}` : 'весь заказ';
  }, [orderOptions, selectedOrderIds]);

  const allPresets = useMemo(() => dedupeCommentPresets([
    { label: 'Весь заказ', commentText: orderPresetText, category: 'order' },
    ...DEFAULT_COMMENT_PRESETS,
    ...presets,
  ]), [orderPresetText, presets]);

  const matchProblems = useMemo(() => {
    if (informationalUpload) return [];
    if (!parsed?.cutLayout.items.length || eligibleLoading) return [];
    return buildSvgMatchProblems(parsed.cutLayout.items, eligibleDetails);
  }, [eligibleDetails, eligibleLoading, informationalUpload, parsed]);

  const blockingMatchProblems = useMemo(
    () => matchProblems.filter((problem) => problem.severity === 'error'),
    [matchProblems],
  );
  const warningMatchProblems = useMemo(
    () => matchProblems.filter((problem) => problem.severity === 'warning'),
    [matchProblems],
  );

  const replaceSvgPreview = useCallback((next: SvgPreviewState | null) => {
    revokeObjectUrl(svgPreviewUrlRef.current);
    svgPreviewUrlRef.current = next?.url ?? null;
    setSvgPreview(next);
    if (!next) setSvgPreviewExpanded(false);
  }, []);

  useEffect(() => () => {
    revokeObjectUrl(svgPreviewUrlRef.current);
    svgPreviewUrlRef.current = null;
  }, []);

  const matchSummary = useMemo(() => {
    if (informationalUpload) return null;
    if (!parsed?.cutLayout.items.length) return null;
    const unmatched = blockingMatchProblems.reduce((sum, problem) => sum + Math.max(1, problem.quantity), 0);
    const matched = parsed.cutLayout.items.length - unmatched;
    return {
      matched,
      total: parsed.cutLayout.items.length,
      unmatched,
    };
  }, [blockingMatchProblems, informationalUpload, parsed]);

  const uploadProps: UploadProps = {
    accept: '.svg,image/svg+xml',
    maxCount: 1,
    showUploadList: parsed ? { showRemoveIcon: true } : false,
    beforeUpload: (file) => {
      void handleFile(file);
      return false;
    },
    onRemove: () => {
      setParsed(null);
      replaceSvgPreview(null);
      setEligibleDetails([]);
      setSelectedOrderIds(defaultOrderIds);
      setOrderOptions(defaultOrderOptions);
      setRequestedCutJobId(null);
      setCutJobNumberCheck(EMPTY_CUT_JOB_NUMBER_CHECK);
      setSvgSourceFile(null);
      setGcodeSourceFile(null);
      setScreenshotSourceFile(null);
      setGeneratedScreenshotContrast(MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT);
      return true;
    },
  };

  const searchOrders = useCallback((search: string) => {
    const value = search.trim();
    if (value.length < 2) return;
    setOrderSearchLoading(true);
    ordersApi.list({ search: value, pageSize: 20 })
      .then((response) => {
        setOrderOptions((current) => mergeOrderOptions(current, response.data));
      })
      .catch(() => undefined)
      .finally(() => setOrderSearchLoading(false));
  }, []);

  const addPreset = useCallback((value: string) => {
    const comment = normalizeCommentPresetSegment(value);
    if (!comment.trim()) return;
    setCommentText((current) => appendCommentPreset(current, comment));
    if (comment.toLocaleLowerCase('ru-RU').includes('переделка')) setRework(true);
    if (comment.toLocaleLowerCase('ru-RU').startsWith('материал:')) {
      setMaterialName(comment.split(':').slice(1).join(':').trim());
    }
  }, []);

  const savePreset = useCallback(async () => {
    const comment = normalizeManualSvgCommentForSubmit(commentText);
    if (!comment) {
      message.warning('Нет комментария для пресета');
      return;
    }
    setPresetSaving(true);
    try {
      const preset = await cncTelegramApi.createManualSvgCommentPreset({
        label: comment.split('\n').find(Boolean)?.slice(0, 80) ?? comment.slice(0, 80),
        commentText: comment,
        category: rework ? 'rework' : 'custom',
      }, createPresetIdempotencyKey(comment));
      setPresets((current) => [...current, preset]);
      message.success('Пресет сохранен');
    } catch (error) {
      message.error(isApiError(error) ? error.message : 'Не удалось сохранить пресет');
    } finally {
      setPresetSaving(false);
    }
  }, [commentText, rework]);

  const resetFormState = useCallback(() => {
    setParsed(null);
    setCommentText('');
    setTelegramMessage('');
    setSendToTelegram(true);
    setSvgSourceFile(null);
    setGcodeSourceFile(null);
    setScreenshotSourceFile(null);
    setGeneratedScreenshotContrast(MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT);
    setLenientValidation(true);
    setMaterialName('');
    setMachineName('');
    setRequestedCutJobId(null);
    setCutJobNumberCheck(EMPTY_CUT_JOB_NUMBER_CHECK);
    setRework(false);
    setEligibleDetails([]);
    replaceSvgPreview(null);
  }, [replaceSvgPreview]);

  useEffect(() => {
    if (!open || requestedCutJobId === null) {
      setCutJobNumberCheck(EMPTY_CUT_JOB_NUMBER_CHECK);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setCutJobNumberCheck({ status: 'checking', suggestions: [] });
      void checkRequestedCutJobNumber(requestedCutJobId)
        .then((check) => {
          if (!cancelled) setCutJobNumberCheck(check);
        })
        .catch(() => {
          if (!cancelled) {
            setCutJobNumberCheck({
              status: 'error',
              suggestions: [],
              message: 'Не удалось проверить номер задания',
            });
          }
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, requestedCutJobId]);

  const submit = useCallback(async () => {
    if (!parsed) {
      message.warning('Загрузите SVG-файл');
      return;
    }
    if (parsed.cutLayout.items.length === 0 || parsed.items.length === 0) {
      message.error('SVG не содержит распознанных деталей для формирования раскроя');
      return;
    }
    if (!lenientValidation && parsed.cutLayout.status !== 'valid') {
      message.error(`SVG не прошел валидацию: ${parsed.cutLayout.reasons.join('; ') || 'нет деталей для раскроя'}`);
      return;
    }
    if (selectedOrderIds.length === 0) {
      message.warning('Укажите заказы для раскроя');
      return;
    }
    if (!lenientValidation && !informationalUpload && eligibleLoading) {
      message.warning('Дождитесь проверки деталей выбранных заказов');
      return;
    }
    if (!lenientValidation && !informationalUpload && blockingMatchProblems.length > 0) {
      showSvgMatchProblems(blockingMatchProblems);
      return;
    }
    if (requestedCutJobId !== null && cutJobNumberCheck.status !== 'available') {
      message.warning(cutJobNumberCheck.status === 'duplicate'
        ? 'Выберите свободный номер задания'
        : 'Дождитесь проверки номера задания');
      return;
    }
    if (!lenientValidation && !informationalUpload && warningMatchProblems.length > 0 && !await confirmSvgMatchWarnings(warningMatchProblems)) {
      return;
    }

    if (!svgSourceFile) {
      message.warning('Перезагрузите SVG-файл: не удалось подготовить файл для хранения');
      return;
    }

    const uploadComment = normalizeManualSvgCommentForSubmit(commentText);
    const telegramMessageText = normalizeManualSvgCommentForSubmit(telegramMessage) || uploadComment;
    const sourceFiles = manualSvgUploadSourceFiles([svgSourceFile, gcodeSourceFile, screenshotSourceFile]);
    const idempotencyKey = createIdempotencyKey([
      parsed.svgContentHash,
      manualSvgUploadFilesFingerprint(sourceFiles),
      manualSvgGeneratedScreenshotContrastKey(generatedScreenshotContrast, Boolean(screenshotSourceFile)),
      sendToTelegram ? telegramMessageText : 'telegram-off',
      lenientValidation ? 'lenient' : 'strict',
      'mdf-card-first',
    ].join(':'));
    setSubmitting(true);
    try {
      const uploadBody: CncTelegramManualSvgUploadRequest = {
        selectedOrderIds,
        createMdfMachineFileCard: true,
        matchMode: uploadMatchMode,
        validationMode: lenientValidation ? 'lenient' : 'strict',
        requestedCutJobId,
        svgContentHash: parsed.svgContentHash,
        machine: machineName.trim() || null,
        programName: parsed.fileName,
        materialName: materialName.trim() || null,
        rework,
        comments: uploadComment ? [uploadComment] : [],
        parserVersion: 'erp-manual-svg-upload-v1',
        sourceFiles,
        generatedScreenshot: {
          contrast: screenshotSourceFile ? null : normalizeManualSvgGeneratedScreenshotContrast(generatedScreenshotContrast),
        },
        telegramSend: {
          enabled: sendToTelegram,
          message: telegramMessageText || null,
        },
        cutLayout: parsed.cutLayout,
        items: parsed.items,
      };
      const response = await cncTelegramApi.manualSvgUpload(uploadBody, idempotencyKey);

      const cutJobId = response.cutJobId;
      const cutJobPath = response.cutJobPath ?? (cutJobId ? `/cut?job=${cutJobId}` : null);
      const cutJobDisplayNumber = await resolveManualSvgCutJobDisplayNumber(response.cutJobDisplayNumber ?? response.packet.svgCutJobDisplayNumber ?? null, cutJobId);
      const cutJobDisplayLabel = formatCutJobDisplayLabel(cutJobDisplayNumber, cutJobId);
      const mdfCardCreated = response.createdMdfMachineFileCard;
      const openCutJob = cutJobPath
        ? () => {
            Modal.destroyAll();
            navigate(cutJobPath);
          }
        : undefined;
      Modal.success({
        title: cutJobId
          ? `Задание на раскрой ${cutJobDisplayLabel} сформировано`
          : 'SVG загружен, требуется проверка раскроя',
        okText: cutJobPath ? 'Открыть задание' : 'OK',
        onOk: openCutJob,
        content: cutJobPath ? (
          <Space direction="vertical" size={8}>
            <Button
              type="link"
              icon={<LinkOutlined />}
              onClick={openCutJob}
            >
              Открыть задание {cutJobDisplayLabel}
            </Button>
            {mdfCardCreated && (
              <Typography.Text type="success">
                Карточка файла станка создана для Доски МДФ
              </Typography.Text>
            )}
            {response.storedFileCount ? (
              <Typography.Text type="secondary">
                Файлы сохранены: {response.storedFileCount}. Telegram: {formatTelegramSendStatus(response.telegramSendStatus)}
              </Typography.Text>
            ) : null}
          </Space>
        ) : (
          response.packet.svgCutImportNote ?? 'Проверьте карточку файла станка на Доске МДФ'
        ),
      });
      onDone?.(cutJobId);
      resetFormState();
      onClose();
    } catch (error) {
      if (isApiError(error, 'CUT_JOB_NUMBER_CONFLICT')) {
        setCutJobNumberCheck({
          status: 'duplicate',
          suggestions: suggestedCutJobIdsFromErrorDetails(error.details),
          message: error.message,
        });
        message.error(error.message);
        return;
      }
      if (
        isApiError(error, 'MANUAL_SVG_UNMATCHED_DETAILS') ||
        isApiError(error, 'MANUAL_SVG_ORDER_SCOPE_MISMATCH')
      ) {
        showManualSvgApiMatchError(error);
        return;
      }
      message.error(isApiError(error) ? error.message : 'Не удалось загрузить SVG-раскрой');
    } finally {
      setSubmitting(false);
    }
  }, [
    commentText,
    telegramMessage,
    sendToTelegram,
    svgSourceFile,
    gcodeSourceFile,
    screenshotSourceFile,
    generatedScreenshotContrast,
    lenientValidation,
    machineName,
    materialName,
    matchSummary,
    blockingMatchProblems,
    warningMatchProblems,
    eligibleLoading,
    informationalUpload,
    navigate,
    onClose,
    onDone,
    parsed,
    cutJobNumberCheck.status,
    requestedCutJobId,
    resetFormState,
    rework,
    selectedOrderIds,
    uploadMatchMode,
  ]);

  const resetAndClose = useCallback(() => {
    resetFormState();
    onClose();
  }, [onClose, resetFormState]);

  async function handleFile(file: File) {
    setParsing(true);
    setSvgSourceFile(null);
    setGcodeSourceFile(null);
    setScreenshotSourceFile(null);
    setGeneratedScreenshotContrast(MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT);
    replaceSvgPreview(createSvgPreview(file));
    try {
      const sourceFile = await fileToManualSvgUploadFile(file, 'svg');
      const fileNameHints = parseSvgCutUploadFileNameHints(file.name);
      const parseAsInformational = svgUploadMaterialIsInformational(
        fileNameHints.materialName ?? materialName,
        file.name,
      );
      const result = await parseSvgCutUploadFile(file, {
        allowGeometryFallbackItems: parseAsInformational,
        includeVisualLabelOnlyItems: true,
        fallbackOrderName: fileNameHints.orderNames.join('+') || defaultOrderNames[0] || null,
      });
      setParsed(result);
      replaceSvgPreview(createEnhancedSvgPreview(await file.text(), file.name) ?? createSvgPreview(file));
      setSvgSourceFile({ payload: sourceFile, selectedAt: Date.now() });
      if (fileNameHints.machineName) {
        setMachineName(fileNameHints.machineName);
      }
      if (fileNameHints.materialName) {
        setMaterialName(fileNameHints.materialName);
      }
      if (fileNameHints.orderNames.length > 0) {
        void applyFileNameOrderHints(fileNameHints.orderNames);
      }
      if (result.cutLayout.status === 'valid') {
        const inferredMaterial = inferMaterialName(result.cutLayout.items, result.fileName);
        if (inferredMaterial && !fileNameHints.materialName) setMaterialName(inferredMaterial);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось прочитать SVG');
    } finally {
      setParsing(false);
    }
  }

  async function handleAuxiliaryFile(file: File, kind: 'gcode' | 'screenshot') {
    try {
      const payload = await fileToManualSvgUploadFile(file, kind);
      const state = { payload, selectedAt: Date.now() };
      if (kind === 'gcode') setGcodeSourceFile(state);
      else setScreenshotSourceFile(state);
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось подготовить файл');
    }
  }

  async function applyFileNameOrderHints(orderNames: string[]) {
    setOrderSearchLoading(true);
    try {
      const lookup = await findOrdersByFileNameHints(orderNames);
      setOrderOptions((current) => mergeOrderOptions(current, lookup.orders));
      if (lookup.matchedOrderIds.length > 0) {
        setSelectedOrderIds(uniqueNumbers([...defaultOrderIds, ...lookup.matchedOrderIds]));
        message.success(`Заказы из имени файла найдены: ${lookup.matchedOrderNames.join(', ')}`);
      }
      if (lookup.missingOrderNames.length > 0) {
        message.warning(`Не найдены заказы из имени файла: ${lookup.missingOrderNames.join(', ')}`);
      }
    } catch {
      message.warning('Не удалось найти заказы из имени SVG-файла');
    } finally {
      setOrderSearchLoading(false);
    }
  }

  const cutJobNumberSubmitBlocked = requestedCutJobId !== null && cutJobNumberCheck.status !== 'available';
  const orderDetailMatchLoading = !informationalUpload && eligibleLoading;
  const strictSvgValidationBlocked = !lenientValidation && parsed !== null && parsed.cutLayout.status !== 'valid';
  const noRecognizedSvgItems = parsed !== null && (parsed.cutLayout.items.length === 0 || parsed.items.length === 0);
  const orderDetailMatchSubmitBlocked = !lenientValidation && orderDetailMatchLoading;
  const floatingPreview = svgPreview && svgPreviewExpanded ? (
    <FloatingSvgPreview
      preview={svgPreview}
      parsed={parsed}
      screenshotContrast={generatedScreenshotContrast}
      contrastEnabled={!screenshotSourceFile}
      onClose={() => setSvgPreviewExpanded(false)}
    />
  ) : null;

  if (open && minimized) {
    return (
      <>
        <MinimizedSvgUpload
          fileName={parsed?.fileName ?? svgPreview?.fileName ?? null}
          status={parsing ? 'Проверка файла' : submitting ? 'Формирование раскроя' : parsed ? 'Форма свернута' : 'Файл не выбран'}
          onRestore={() => setMinimized(false)}
        />
        {floatingPreview}
      </>
    );
  }

  return (
    <>
      <Modal
        open={open}
        title={(
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingRight: 32 }}>
            <span>Загрузка SVG-раскроя</span>
            <Tooltip title="Свернуть">
              <Button
                aria-label="Свернуть загрузку SVG-раскроя"
                icon={<MinusOutlined />}
                onClick={(event) => {
                  event.stopPropagation();
                  setMinimized(true);
                }}
                size="small"
                type="text"
              />
            </Tooltip>
          </div>
        )}
        width={1040}
        onCancel={resetAndClose}
        maskClosable={false}
        keyboard={false}
        okText="Сформировать раскрой"
        onOk={() => void submit()}
        confirmLoading={submitting}
        okButtonProps={{
          disabled: !parsed || strictSvgValidationBlocked || noRecognizedSvgItems || selectedOrderIds.length === 0 || orderDetailMatchSubmitBlocked || cutJobNumberSubmitBlocked,
          icon: <FileAddOutlined />,
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: 16,
            alignItems: 'flex-start',
            flexWrap: 'wrap',
          }}
        >
        <Space
          direction="vertical"
          size="middle"
          style={{
            flex: '1 1 560px',
            minWidth: 0,
          }}
        >
          <Upload.Dragger {...uploadProps} disabled={parsing || submitting}>
            <p className="ant-upload-drag-icon"><UploadOutlined /></p>
            <p className="ant-upload-text">SVG-файл раскроя</p>
            <p className="ant-upload-hint">Файл проверяется сразу после выбора</p>
          </Upload.Dragger>

          {parsed && (
            <SvgValidationSummary
              parsed={parsed}
              eligibleLoading={orderDetailMatchLoading}
              matchMode={uploadMatchMode}
              lenientValidation={lenientValidation}
              matchSummary={matchSummary}
              matchProblems={matchProblems}
            />
          )}

          <Form layout="vertical">
            <Form.Item>
              <Checkbox
                checked={lenientValidation}
                onChange={(event) => setLenientValidation(event.target.checked)}
              >
                Нестрогий режим
              </Checkbox>
            </Form.Item>

            <Form.Item label="Заказы в раскрое" required>
              <Select
                mode="multiple"
                showSearch
                filterOption={false}
                value={selectedOrderIds}
                options={orderOptions}
                loading={orderSearchLoading}
                onSearch={searchOrders}
                onChange={(values) => setSelectedOrderIds(values)}
                placeholder="Найдите заказ по номеру или названию"
              />
            </Form.Item>

            <Space size="middle" style={{ width: '100%' }} align="start">
              <Form.Item label="Материал" style={{ flex: 1, minWidth: 220 }}>
                <Input
                  value={materialName}
                  onChange={(event) => setMaterialName(event.target.value)}
                  placeholder="МДФ 16мм"
                />
              </Form.Item>
              <Form.Item label="Станок" style={{ flex: 1, minWidth: 180 }}>
                <Input
                  value={machineName}
                  onChange={(event) => setMachineName(event.target.value)}
                  placeholder="manual-svg-upload"
                />
              </Form.Item>
              <Form.Item
                label="№ задания"
                tooltip="Оставьте пустым для авто-номера"
                validateStatus={cutJobNumberValidateStatus(cutJobNumberCheck)}
                help={renderCutJobNumberHelp(cutJobNumberCheck, setRequestedCutJobId)}
                style={{ width: 190 }}
              >
                <InputNumber
                  value={requestedCutJobId}
                  onChange={(value) => setRequestedCutJobId(normalizeRequestedCutJobId(value))}
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  precision={0}
                  controls={false}
                  placeholder="авто"
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item label="Тип">
                <Checkbox checked={rework} onChange={(event) => setRework(event.target.checked)}>
                  Переделка
                </Checkbox>
              </Form.Item>
            </Space>

            <Form.Item label="Пресеты комментариев">
              <Space wrap>
                {allPresets.map((preset, index) => (
                  <Button
                    key={`${preset.category}:${preset.commentText}:${index}`}
                    size="small"
                    onClick={() => addPreset(preset.commentText)}
                  >
                    {preset.label}
                  </Button>
                ))}
                <Button
                  size="small"
                  onClick={() => setCommentText((current) => appendCommentLineBreak(current))}
                >
                  Перенос строки
                </Button>
              </Space>
            </Form.Item>

            <Form.Item label="Комментарий">
              <Input.TextArea
                value={commentText}
                onChange={(event) => setCommentText(normalizeManualSvgCommentInput(event.target.value))}
                placeholder="весь заказ, фрезы, материал, переделка"
                autoSize={{ minRows: 2, maxRows: 5 }}
              />
            </Form.Item>
            <Form.Item label="Telegram и файлы">
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Checkbox
                  checked={sendToTelegram}
                  onChange={(event) => setSendToTelegram(event.target.checked)}
                >
                  Отправить файлы в Telegram-чат
                </Checkbox>
                <Input.TextArea
                  value={telegramMessage}
                  onChange={(event) => setTelegramMessage(normalizeManualSvgCommentInput(event.target.value))}
                  placeholder="Сообщение в Telegram; если пусто, будет использован комментарий"
                  disabled={!sendToTelegram}
                  autoSize={{ minRows: 2, maxRows: 4 }}
                />
                <Space wrap>
                  <Upload
                    accept=".nc,.cnc,.tap,.gcode,.iso,.txt,text/plain"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(file) => {
                      void handleAuxiliaryFile(file, 'gcode');
                      return false;
                    }}
                    disabled={submitting}
                  >
                    <Button icon={<UploadOutlined />}>G-code</Button>
                  </Upload>
                  <Upload
                    accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(file) => {
                      void handleAuxiliaryFile(file, 'screenshot');
                      return false;
                    }}
                    disabled={submitting}
                  >
                    <Button icon={<UploadOutlined />}>Скрин</Button>
                  </Upload>
                  {gcodeSourceFile && (
                    <ManualSvgAttachmentTag
                      file={gcodeSourceFile.payload}
                      onClose={() => setGcodeSourceFile(null)}
                    />
                  )}
                  {screenshotSourceFile && (
                    <ManualSvgAttachmentTag
                      file={screenshotSourceFile.payload}
                      onClose={() => setScreenshotSourceFile(null)}
                    />
                  )}
                  {svgSourceFile && (
                    <Tag color="blue">
                      SVG: {svgSourceFile.payload.fileName}
                    </Tag>
                  )}
                </Space>
              </Space>
            </Form.Item>
            <Button
              icon={<SaveOutlined />}
              loading={presetSaving}
              onClick={() => void savePreset()}
            >
              Сохранить комментарий как пресет
            </Button>
          </Form>
        </Space>

        <SvgUploadPreview
          preview={svgPreview}
          parsed={parsed}
          screenshotContrast={generatedScreenshotContrast}
          contrastEnabled={!screenshotSourceFile}
          onContrastChange={setGeneratedScreenshotContrast}
          onOpenExpanded={() => setSvgPreviewExpanded(true)}
        />
        </div>
      </Modal>
      {floatingPreview}
    </>
  );
};

function MinimizedSvgUpload({
  fileName,
  status,
  onRestore,
}: {
  fileName: string | null;
  status: string;
  onRestore: () => void;
}) {
  return (
    <button
      type="button"
      className="manual-svg-upload-minimized"
      onClick={onRestore}
      aria-label="Развернуть загрузку SVG-раскроя"
    >
      <span className="manual-svg-upload-minimized__icon" aria-hidden="true">
        <UploadOutlined />
      </span>
      <span className="manual-svg-upload-minimized__copy">
        <strong>Загрузка SVG-раскроя</strong>
        <span>{fileName ?? status}</span>
      </span>
      {fileName ? <span className="manual-svg-upload-minimized__status">{status}</span> : null}
    </button>
  );
}

function ManualSvgAttachmentTag({
  file,
  onClose,
}: {
  file: CncTelegramManualSvgUploadFile;
  onClose: () => void;
}) {
  return (
    <Tag
      closable
      onClose={onClose}
      color={file.kind === 'gcode' ? 'purple' : 'cyan'}
    >
      {manualSvgUploadFileKindLabel(file.kind)}: {file.fileName}
    </Tag>
  );
}

function SvgUploadPreview({
  preview,
  parsed,
  screenshotContrast,
  contrastEnabled,
  onContrastChange,
  onOpenExpanded,
}: {
  preview: SvgPreviewState | null;
  parsed: ParsedSvgUpload | null;
  screenshotContrast: number;
  contrastEnabled: boolean;
  onContrastChange: (value: number) => void;
  onOpenExpanded: () => void;
}) {
  const sheetSize = parsed?.cutLayout.sheet
    ? `${parsed.cutLayout.sheet.widthMm} x ${parsed.cutLayout.sheet.heightMm} мм`
    : null;
  return (
    <div
      style={{
        flex: '0 0 320px',
        maxWidth: '100%',
        height: 360,
        borderRadius: 8,
        background: '#ffffff',
        boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.12)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          borderBottom: '1px solid #f0f0f0',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong>Превью SVG</Typography.Text>
          <Typography.Text
            type="secondary"
            ellipsis={preview ? { tooltip: preview.fileName } : true}
            style={{
              display: 'block',
              maxWidth: '100%',
              fontSize: 12,
            }}
          >
            {preview?.fileName ?? 'Файл не выбран'}
          </Typography.Text>
        </div>
        <Tooltip title={preview ? 'Открыть крупное превью' : 'Сначала выберите SVG'}>
          <Button
            type="text"
            size="small"
            icon={<FullscreenOutlined />}
            disabled={!preview}
            aria-label="Открыть крупное превью SVG"
            onClick={onOpenExpanded}
            style={{ minWidth: 32 }}
          />
        </Tooltip>
      </div>
      <div
        role={preview ? 'button' : undefined}
        tabIndex={preview ? 0 : undefined}
        onClick={preview ? onOpenExpanded : undefined}
        onKeyDown={preview ? (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpenExpanded();
          }
        } : undefined}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fafafa',
          padding: 8,
          cursor: preview ? 'zoom-in' : 'default',
          outline: 'none',
        }}
      >
        {preview ? (
          <img
            src={preview.url}
            alt="Превью SVG-раскроя"
            draggable={false}
            decoding="async"
            style={{
              display: 'block',
              maxWidth: '100%',
              maxHeight: '100%',
              width: 'auto',
              height: 'auto',
              objectFit: 'contain',
              filter: manualSvgScreenshotPreviewFilter(screenshotContrast, contrastEnabled),
              background: '#ffffff',
              outline: '1px solid rgba(0, 0, 0, 0.1)',
            }}
          />
        ) : (
          <Typography.Text type="secondary">Выберите SVG-файл</Typography.Text>
        )}
      </div>
      <div
        style={{
          padding: '8px 12px 10px',
          borderTop: '1px solid #f0f0f0',
        }}
      >
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Контраст скрина
            </Typography.Text>
            <Typography.Text
              type={contrastEnabled ? 'secondary' : 'warning'}
              style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
            >
              {contrastEnabled ? `${Math.round(screenshotContrast * 100)}%` : 'загружен скрин'}
            </Typography.Text>
          </div>
          <Slider
            min={MANUAL_SVG_SCREENSHOT_CONTRAST_MIN}
            max={MANUAL_SVG_SCREENSHOT_CONTRAST_MAX}
            step={MANUAL_SVG_SCREENSHOT_CONTRAST_STEP}
            value={screenshotContrast}
            onChange={(value) => {
              const next = Array.isArray(value) ? value[0] ?? MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT : value;
              onContrastChange(normalizeManualSvgGeneratedScreenshotContrast(next));
            }}
            disabled={!contrastEnabled}
            tooltip={{ formatter: (value) => `${Math.round((value ?? screenshotContrast) * 100)}%` }}
            style={{ margin: '0 2px 2px' }}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {sheetSize ?? 'Пропорции сохраняются при показе'}
          </Typography.Text>
        </Space>
      </div>
    </div>
  );
}

function FloatingSvgPreview({
  preview,
  parsed,
  screenshotContrast,
  contrastEnabled,
  onClose,
}: {
  preview: SvgPreviewState;
  parsed: ParsedSvgUpload | null;
  screenshotContrast: number;
  contrastEnabled: boolean;
  onClose: () => void;
}) {
  const sheetSize = parsed?.cutLayout.sheet
    ? `${parsed.cutLayout.sheet.widthMm} x ${parsed.cutLayout.sheet.heightMm} мм`
    : 'размер листа не определен';
  const [rect, setRect] = useState(defaultFloatingSvgPreviewRect);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    rect: FloatingSvgPreviewRect;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    corner: FloatingSvgPreviewResizeCorner;
    startX: number;
    startY: number;
    rect: FloatingSvgPreviewRect;
  } | null>(null);

  useEffect(() => {
    const handleResize = () => setRect((current) => clampFloatingSvgPreviewRect(current));
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [rect]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setRect(clampFloatingSvgPreviewRect({
      ...drag.rect,
      left: drag.rect.left + event.clientX - drag.startX,
      top: drag.rect.top + event.clientY - drag.startY,
    }));
  }, []);

  const finishDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  }, []);

  const handleResizePointerDown = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    corner: FloatingSvgPreviewResizeCorner,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      corner,
      startX: event.clientX,
      startY: event.clientY,
      rect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [rect]);

  const handleResizePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    setRect(resizeFloatingSvgPreviewRect(
      resize.rect,
      event.clientX - resize.startX,
      event.clientY - resize.startY,
      resize.corner,
    ));
  }, []);

  const finishResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
  }, []);

  const previewNode = (
    <div
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        position: 'fixed',
        left: rect.left,
        top: rect.top,
        zIndex: 2000,
        width: rect.width,
        height: rect.height,
        borderRadius: 8,
        background: '#ffffff',
        boxShadow: '0 18px 45px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(0, 0, 0, 0.1)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
      aria-label="Крупное превью SVG-раскроя"
    >
      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        style={{
          minHeight: 48,
          padding: '8px 10px 8px 14px',
          cursor: 'move',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          borderBottom: '1px solid #f0f0f0',
          userSelect: 'none',
          touchAction: 'none',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <Typography.Text strong ellipsis={{ tooltip: preview.fileName }} style={{ display: 'block' }}>
            {preview.fileName}
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {sheetSize}
          </Typography.Text>
        </div>
        <Space size={4} onPointerDown={stopFloatingSvgPreviewActionPointerDown}>
          <Tooltip title="Распечатать SVG">
            <Button
              type="text"
              icon={<PrinterOutlined />}
              aria-label="Распечатать SVG-превью"
              onClick={(event) => {
                event.stopPropagation();
                printSvgPreview(preview.url, preview.fileName);
              }}
            />
          </Tooltip>
          <Tooltip title="Закрыть">
            <Button
              type="text"
              icon={<CloseOutlined />}
              aria-label="Закрыть крупное превью SVG"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            />
          </Tooltip>
        </Space>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          background: '#fafafa',
          padding: 12,
        }}
      >
        <img
          src={preview.url}
          alt="Крупное превью SVG-раскроя"
          draggable={false}
          decoding="async"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            outline: '1px solid rgba(0, 0, 0, 0.1)',
            background: '#ffffff',
            filter: manualSvgScreenshotPreviewFilter(screenshotContrast, contrastEnabled),
          }}
        />
      </div>
      {(['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
        <div
          key={corner}
          aria-label={`Изменить размер крупного превью SVG: ${corner}`}
          onPointerDown={(event) => handleResizePointerDown(event, corner)}
          onPointerMove={handleResizePointerMove}
          onPointerUp={finishResize}
          onPointerCancel={finishResize}
          style={floatingSvgPreviewResizeHandleStyle(corner)}
        />
      ))}
    </div>
  );

  if (typeof document === 'undefined') return previewNode;
  return createPortal(previewNode, document.body);
}

function stopFloatingSvgPreviewActionPointerDown(event: React.PointerEvent): void {
  event.stopPropagation();
}

function defaultFloatingSvgPreviewRect(): FloatingSvgPreviewRect {
  if (typeof window === 'undefined') {
    return {
      left: 24,
      top: 72,
      width: FLOATING_SVG_PREVIEW_DEFAULT_WIDTH,
      height: FLOATING_SVG_PREVIEW_DEFAULT_HEIGHT,
    };
  }
  const width = Math.min(
    FLOATING_SVG_PREVIEW_DEFAULT_WIDTH,
    Math.max(FLOATING_SVG_PREVIEW_MIN_WIDTH, window.innerWidth - FLOATING_SVG_PREVIEW_MARGIN * 2),
  );
  const height = Math.min(
    FLOATING_SVG_PREVIEW_DEFAULT_HEIGHT,
    Math.max(FLOATING_SVG_PREVIEW_MIN_HEIGHT, window.innerHeight - FLOATING_SVG_PREVIEW_MARGIN * 2),
  );
  return clampFloatingSvgPreviewRect({
    left: window.innerWidth - width - 24,
    top: Math.min(88, window.innerHeight - height - 16),
    width,
    height,
  });
}

function clampFloatingSvgPreviewRect(rect: FloatingSvgPreviewRect): FloatingSvgPreviewRect {
  if (typeof window === 'undefined') return rect;
  const maxWidth = Math.max(FLOATING_SVG_PREVIEW_MIN_WIDTH, window.innerWidth - FLOATING_SVG_PREVIEW_MARGIN * 2);
  const maxHeight = Math.max(FLOATING_SVG_PREVIEW_MIN_HEIGHT, window.innerHeight - FLOATING_SVG_PREVIEW_MARGIN * 2);
  const width = clampNumber(rect.width, FLOATING_SVG_PREVIEW_MIN_WIDTH, maxWidth);
  const height = clampNumber(rect.height, FLOATING_SVG_PREVIEW_MIN_HEIGHT, maxHeight);
  return {
    left: clampNumber(
      rect.left,
      FLOATING_SVG_PREVIEW_MARGIN,
      Math.max(FLOATING_SVG_PREVIEW_MARGIN, window.innerWidth - width - FLOATING_SVG_PREVIEW_MARGIN),
    ),
    top: clampNumber(
      rect.top,
      FLOATING_SVG_PREVIEW_MARGIN,
      Math.max(FLOATING_SVG_PREVIEW_MARGIN, window.innerHeight - height - FLOATING_SVG_PREVIEW_MARGIN),
    ),
    width,
    height,
  };
}

function resizeFloatingSvgPreviewRect(
  rect: FloatingSvgPreviewRect,
  deltaX: number,
  deltaY: number,
  corner: FloatingSvgPreviewResizeCorner,
): FloatingSvgPreviewRect {
  const next = { ...rect };
  const maxWidth = typeof window === 'undefined'
    ? FLOATING_SVG_PREVIEW_DEFAULT_WIDTH
    : Math.max(FLOATING_SVG_PREVIEW_MIN_WIDTH, window.innerWidth - FLOATING_SVG_PREVIEW_MARGIN * 2);
  const maxHeight = typeof window === 'undefined'
    ? FLOATING_SVG_PREVIEW_DEFAULT_HEIGHT
    : Math.max(FLOATING_SVG_PREVIEW_MIN_HEIGHT, window.innerHeight - FLOATING_SVG_PREVIEW_MARGIN * 2);
  if (corner.includes('right')) {
    next.width = clampNumber(rect.width + deltaX, FLOATING_SVG_PREVIEW_MIN_WIDTH, maxWidth);
  } else {
    const right = rect.left + rect.width;
    next.left = clampNumber(rect.left + deltaX, right - maxWidth, right - FLOATING_SVG_PREVIEW_MIN_WIDTH);
    next.width = right - next.left;
  }
  if (corner.includes('bottom')) {
    next.height = clampNumber(rect.height + deltaY, FLOATING_SVG_PREVIEW_MIN_HEIGHT, maxHeight);
  } else {
    const bottom = rect.top + rect.height;
    next.top = clampNumber(rect.top + deltaY, bottom - maxHeight, bottom - FLOATING_SVG_PREVIEW_MIN_HEIGHT);
    next.height = bottom - next.top;
  }
  return clampFloatingSvgPreviewRect(next);
}

function floatingSvgPreviewResizeHandleStyle(corner: FloatingSvgPreviewResizeCorner): React.CSSProperties {
  const size = 18;
  const inset = -2;
  const style: React.CSSProperties = {
    position: 'absolute',
    width: size,
    height: size,
    zIndex: 1,
    touchAction: 'none',
    cursor: corner === 'top-left' || corner === 'bottom-right' ? 'nwse-resize' : 'nesw-resize',
  };
  if (corner.includes('top')) style.top = inset;
  if (corner.includes('bottom')) style.bottom = inset;
  if (corner.includes('left')) style.left = inset;
  if (corner.includes('right')) style.right = inset;
  return style;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function printSvgPreview(url: string, title: string): void {
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
  documentRef.write(`<!doctype html><html><head><title>${escapeHtml(title)}</title><style>@page{margin:8mm}html,body{margin:0;width:100%;height:100%}body{display:flex;align-items:center;justify-content:center}img{display:block;max-width:100%;max-height:calc(100vh - 16mm);object-fit:contain}</style></head><body><img src="${escapeHtml(url)}" alt=""></body></html>`);
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

function createSvgPreview(file: File): SvgPreviewState | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return {
    url: URL.createObjectURL(file),
    fileName: file.name,
  };
}

function createEnhancedSvgPreview(svg: string, fileName: string): SvgPreviewState | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return {
    url: URL.createObjectURL(createRawSvgUploadPreviewBlob(svg)),
    fileName,
  };
}

function revokeObjectUrl(url: string | null): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(url);
}

function SvgValidationSummary({
  parsed,
  eligibleLoading,
  matchMode,
  lenientValidation,
  matchSummary,
  matchProblems,
}: {
  parsed: ParsedSvgUpload;
  eligibleLoading: boolean;
  matchMode: SvgUploadMatchMode;
  lenientValidation: boolean;
  matchSummary: { matched: number; total: number; unmatched: number } | null;
  matchProblems: SvgMatchProblem[];
}) {
  const layout = parsed.cutLayout;
  const valid = layout.status === 'valid';
  const errorCount = matchProblems.filter((problem) => problem.severity === 'error').length;
  const warningCount = matchProblems.length - errorCount;
  const informational = matchMode === 'informational';
  return (
    <Alert
      type={!valid || errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : informational ? 'info' : 'success'}
      showIcon
      message={valid
        ? informational
          ? 'SVG прошел проверку для информативного раскроя'
          : 'SVG прошел базовую проверку'
        : lenientValidation
          ? 'SVG не прошел проверку, но будет принят в нестрогом режиме'
          : 'SVG не прошел проверку'}
      description={(
        <Space direction="vertical" size={6}>
          <Space wrap>
            <Tag>{parsed.fileName}</Tag>
            {layout.sheet && <Tag>{layout.sheet.widthMm} x {layout.sheet.heightMm} мм</Tag>}
            <Tag>{layout.acceptedItemCount ?? layout.items.length} деталей</Tag>
            <Tag>{layout.partContourCount ?? 0} контуров</Tag>
            {lenientValidation && <Tag color="gold">нестрогий режим</Tag>}
            {informational && <Tag color="blue">без сверки ERP-деталей</Tag>}
            {matchSummary && (
              <Tag color={matchSummary.unmatched ? 'orange' : 'green'}>
                {eligibleLoading ? 'проверка заказов...' : `${matchSummary.matched}/${matchSummary.total} найдены в заказах`}
              </Tag>
            )}
          </Space>
          {informational && valid && (
            <Typography.Text type="secondary">
              Размеры и список деталей берутся из SVG. Задание будет связано с выбранными заказами без привязки к деталям заказа.
            </Typography.Text>
          )}
          {lenientValidation && !informational && (
            <Typography.Text type="secondary">
              Ошибки и несовпадения показаны как предупреждения; список деталей будет взят из SVG.
            </Typography.Text>
          )}
          {layout.reasons.length > 0 && (
            <Typography.Text type="danger">
              {layout.reasons.join('; ')}
            </Typography.Text>
          )}
          {matchProblems.length > 0 && (
            <Space direction="vertical" size={4}>
              <Typography.Text type={errorCount > 0 ? 'danger' : 'warning'}>
                {errorCount > 0
                  ? `Проблемные детали: ${errorCount}`
                  : `Предупреждения по деталям: ${warningCount}`}
              </Typography.Text>
              {matchProblems.slice(0, 6).map((problem) => (
                <Typography.Text
                  key={problem.key}
                  type={problem.severity === 'error' ? 'danger' : 'warning'}
                >
                  {problem.title}: {problem.reason}
                </Typography.Text>
              ))}
              {matchProblems.length > 6 && (
                <Typography.Text type="secondary">
                  Еще {matchProblems.length - 6}; полный список будет показан при формировании
                </Typography.Text>
              )}
            </Space>
          )}
        </Space>
      )}
    />
  );
}

function showSvgMatchProblems(problems: SvgMatchProblem[]): void {
  Modal.warning({
    title: 'Детали SVG не сопоставлены с выбранными заказами',
    width: 720,
    content: (
      <Space direction="vertical" size={8}>
        {problems.map((problem) => (
          <Alert
            key={problem.key}
            type={problem.severity === 'error' ? 'error' : 'warning'}
            showIcon
            message={problem.title}
            description={problem.reason}
          />
        ))}
      </Space>
    ),
  });
}

function confirmSvgMatchWarnings(problems: SvgMatchProblem[]): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: 'Детали уже есть в активных раскроях',
      width: 720,
      okText: 'Формировать всё равно',
      cancelText: 'Вернуться',
      content: (
        <Space direction="vertical" size={8}>
          <Typography.Text>
            Это предупреждение не запрещает новый раскрой. Проверьте список и продолжите, если это ожидаемо.
          </Typography.Text>
          {problems.map((problem) => (
            <Alert
              key={problem.key}
              type="warning"
              showIcon
              message={problem.title}
              description={problem.reason}
            />
          ))}
        </Space>
      ),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function buildSvgMatchProblems(
  items: ParsedSvgUpload['cutLayout']['items'],
  details: EligibleDetailDto[],
): SvgMatchProblem[] {
  const problems: SvgMatchProblem[] = [];
  for (const item of groupSvgItems(items)) {
    const title = svgItemTitle(item);
    const itemKey = `${item.orderName}:${item.detailNumber}:${item.widthMm}:${item.heightMm}`;
    const sameOrder = details.filter((detail) => String(detail.orderName ?? '') === item.orderName);
    if (sameOrder.length === 0) {
      problems.push({
        severity: 'error',
        key: `${itemKey}:order`,
        title,
        reason: `Заказ ${item.orderName} не найден среди выбранных заказов или удален`,
        quantity: item.quantity,
      });
      continue;
    }

    const sameDetailNumber = sameOrder.filter((detail) => detail.detailNumber === item.detailNumber);
    if (sameDetailNumber.length === 0) {
      problems.push({
        severity: 'error',
        key: `${itemKey}:detail`,
        title,
        reason: `В заказе ${item.orderName} нет детали #${item.detailNumber}. Есть детали: ${detailNumbersPreview(sameOrder)}`,
        quantity: item.quantity,
      });
      continue;
    }

    const sameSize = sameDetailNumber.filter((detail) =>
      detailMatchesSvgItem(detail, item.orderName, item.detailNumber, item.widthMm, item.heightMm),
    );
    if (sameSize.length === 0) {
      problems.push({
        severity: 'error',
        key: `${itemKey}:size`,
        title,
        reason: `Размер в SVG ${formatMmPair(item.widthMm, item.heightMm)} не совпал с ERP. В ERP: ${detailSizesPreview(sameDetailNumber)}`,
        quantity: item.quantity,
      });
      continue;
    }

    const totalQuantity = sameSize.reduce((sum, detail) => sum + Math.max(0, detail.quantity), 0);
    if (item.quantity > totalQuantity) {
      problems.push({
        severity: 'error',
        key: `${itemKey}:qty`,
        title,
        reason: `Количество в SVG ${item.quantity}, в заказе доступно ${totalQuantity}`,
        quantity: item.quantity,
      });
      continue;
    }

    const placedJobs = sameSize.flatMap((detail) => detail.activeJobs ?? []);
    if (placedJobs.length > 0) {
      problems.push({
        severity: 'warning',
        key: `${itemKey}:jobs`,
        title,
        reason: `Деталь уже есть в активных раскроях: ${cutJobsPreview(placedJobs)}`,
        quantity: item.quantity,
      });
    }
  }
  return problems;
}

function groupSvgItems(items: ParsedSvgUpload['cutLayout']['items']): SvgItemGroup[] {
  const groups = new Map<string, SvgItemGroup>();
  for (const item of items) {
    const key = `${item.orderName}:${item.detailNumber}:${item.widthMm}:${item.heightMm}`;
    const existing = groups.get(key);
    if (existing) {
      existing.quantity += item.quantity;
      continue;
    }
    groups.set(key, {
      orderName: item.orderName,
      detailNumber: item.detailNumber,
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      quantity: item.quantity,
    });
  }
  return Array.from(groups.values());
}

function svgItemTitle(item: SvgItemGroup): string {
  const quantity = item.quantity > 1 ? `, ${item.quantity} шт.` : '';
  return `${item.orderName} деталь #${item.detailNumber} ${formatMmPair(item.widthMm, item.heightMm)}${quantity}`;
}

function detailNumbersPreview(details: EligibleDetailDto[]): string {
  const values = uniqueNumbers(details
    .map((detail) => detail.detailNumber)
    .filter((value): value is number => value !== null));
  return values.length > 0 ? values.slice(0, 12).map((value) => `#${value}`).join(', ') : 'нет номеров деталей';
}

function detailSizesPreview(details: EligibleDetailDto[]): string {
  const values = uniqueStrings(details
    .map((detail) => detail.width != null && detail.height != null
      ? `${formatMmPair(detail.width, detail.height)}${detail.productionStatusName ? ` (${detail.productionStatusName})` : ''}`
      : 'размер не заполнен'));
  return values.slice(0, 8).join(', ');
}

function cutJobsPreview(jobs: EligibleDetailDto['activeJobs']): string {
  return jobs
    .slice(0, 6)
    .map((job) => job.name ? `#${job.cutJobId} ${job.name}` : `#${job.cutJobId}`)
    .join(', ');
}

function showManualSvgApiMatchError(error: ApiError): void {
  const problems = svgMatchProblemsFromApiError(error.details);
  if (problems.length === 0) {
    message.error(error.message);
    return;
  }
  showSvgMatchProblems(problems);
}

function svgMatchProblemsFromApiError(details: unknown): SvgMatchProblem[] {
  if (!details || typeof details !== 'object') return [];
  const raw = (details as { problems?: unknown; items?: unknown }).problems
    ?? (details as { problems?: unknown; items?: unknown }).items;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index): SvgMatchProblem[] => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const orderName = stringFromUnknown(record.orderName) ?? 'без заказа';
    const detailNumber = numberFromUnknown(record.detailNumber);
    const widthMm = numberFromUnknown(record.widthMm);
    const heightMm = numberFromUnknown(record.heightMm);
    const quantity = numberFromUnknown(record.quantity) ?? 1;
    const title = stringFromUnknown(record.title)
      ?? [
        orderName,
        detailNumber !== null ? `деталь #${detailNumber}` : 'деталь без номера',
        widthMm !== null && heightMm !== null ? formatMmPair(widthMm, heightMm) : null,
        quantity > 1 ? `${quantity} шт.` : null,
      ].filter(Boolean).join(' ');
    return [{
      severity: record.severity === 'warning' ? 'warning' : 'error',
      key: stringFromUnknown(record.key) ?? `api:${index}`,
      title,
      reason: stringFromUnknown(record.reason) ?? 'Backend не смог сопоставить позицию SVG с выбранными заказами',
      quantity,
    }];
  });
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberFromUnknown(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatMmPair(width: number, height: number): string {
  return `${formatMm(width)}x${formatMm(height)} мм`;
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function mergeOrderOptions(current: OrderOption[], orders: OrderListItemDto[]): OrderOption[] {
  const map = new Map(current.map((option) => [option.value, option]));
  for (const order of orders) {
    map.set(order.orderId, {
      value: order.orderId,
      label: formatOrderOptionLabel(order),
    });
  }
  return Array.from(map.values());
}

function formatOrderOptionLabel(order: OrderListItemDto): string {
  return order.orderName.trim() || order.fullNumber.trim() || formatDefaultOrderOptionLabel(order.orderId, null);
}

function formatDefaultOrderOptionLabel(orderId: number, orderName: string | null | undefined): string {
  return orderName?.trim() || `Заказ ${orderId}`;
}

async function resolveManualSvgCutJobDisplayNumber(
  displayNumber: string | null | undefined,
  cutJobId: number | null | undefined,
): Promise<string | null> {
  const normalized = normalizeDisplayNumber(displayNumber);
  if (normalized || !isPositiveNumber(cutJobId)) return normalized;
  try {
    const job = await cutApi.get(cutJobId);
    return normalizeDisplayNumber(job.displayNumber);
  } catch {
    return null;
  }
}

function formatCutJobDisplayLabel(
  displayNumber: string | null | undefined,
  cutJobId: number | null | undefined,
): string {
  const normalized = normalizeDisplayNumber(displayNumber);
  if (normalized) {
    if (normalized.startsWith('№')) return normalized;
    if (normalized.startsWith('#')) {
      const withoutHash = normalized.slice(1).trim();
      return withoutHash ? `№${withoutHash}` : normalized;
    }
    return `№${normalized}`;
  }
  return isPositiveNumber(cutJobId) ? `ID ${cutJobId}` : '—';
}

function normalizeDisplayNumber(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeDisplayNumberForCompare(value: string | null | undefined): string | null {
  return normalizeDisplayNumber(value)?.replace(/^[№#]\s*/, '') || null;
}

function isPositiveNumber(value: number | null | undefined): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

async function findOrdersByFileNameHints(orderNames: string[]): Promise<{
  orders: OrderListItemDto[];
  matchedOrderIds: number[];
  matchedOrderNames: string[];
  missingOrderNames: string[];
}> {
  const uniqueOrderNames = uniqueStrings(orderNames);
  const responses = await Promise.all(uniqueOrderNames.map(async (orderName) => {
    try {
      const response = await ordersApi.list({ search: orderName, pageSize: 20 });
      return { orderName, orders: response.data };
    } catch {
      return { orderName, orders: [] };
    }
  }));

  const ordersById = new Map<number, OrderListItemDto>();
  const matchedOrderIds: number[] = [];
  const matchedOrderNames: string[] = [];
  const missingOrderNames: string[] = [];
  for (const response of responses) {
    for (const order of response.orders) {
      ordersById.set(order.orderId, order);
    }
    const exactOrder = response.orders.find((order) => orderMatchesFileNameHint(order, response.orderName));
    if (!exactOrder) {
      missingOrderNames.push(response.orderName);
      continue;
    }
    if (!matchedOrderIds.includes(exactOrder.orderId)) {
      matchedOrderIds.push(exactOrder.orderId);
      matchedOrderNames.push(exactOrder.orderName);
    }
  }
  return {
    orders: Array.from(ordersById.values()),
    matchedOrderIds,
    matchedOrderNames,
    missingOrderNames,
  };
}

function orderMatchesFileNameHint(order: OrderListItemDto, orderName: string): boolean {
  const normalized = orderName.trim();
  if (!normalized) return false;
  if (String(order.orderName ?? '').trim() === normalized) return true;
  if (String(order.fullNumber ?? '').trim() === normalized) return true;
  return (String(order.fullNumber ?? '').match(/\d{3,8}/g) ?? []).includes(normalized);
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function detailMatchesSvgItem(
  detail: EligibleDetailDto,
  orderName: string,
  detailNumber: number,
  widthMm: number,
  heightMm: number,
): boolean {
  if (String(detail.orderName ?? '') !== orderName) return false;
  if (detail.detailNumber !== detailNumber) return false;
  if (detail.width == null || detail.height == null) return false;
  const expected = [widthMm, heightMm].sort((a, b) => a - b);
  const actual = [detail.width, detail.height].sort((a, b) => a - b);
  return Math.max(Math.abs(expected[0] - actual[0]), Math.abs(expected[1] - actual[1])) <= 8;
}

function normalizeRequestedCutJobId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

function cutJobNumberValidateStatus(
  check: CutJobNumberCheck,
): 'success' | 'warning' | 'error' | 'validating' | undefined {
  if (check.status === 'checking') return 'validating';
  if (check.status === 'available') return 'success';
  if (check.status === 'duplicate') return 'error';
  if (check.status === 'error') return 'warning';
  return undefined;
}

function renderCutJobNumberHelp(
  check: CutJobNumberCheck,
  onPick: (cutJobId: number) => void,
): React.ReactNode {
  if (check.status === 'idle') return null;
  if (check.status === 'checking') return 'Проверка номера...';
  if (check.status === 'available') return 'Номер свободен';
  if (check.status === 'error') return check.message ?? 'Не удалось проверить номер';
  if (check.status === 'duplicate') {
    return (
      <Space direction="vertical" size={4}>
        <Typography.Text type="danger">
          {check.message ?? 'Номер уже занят'}
        </Typography.Text>
        {check.suggestions.length > 0 && (
          <Space size={4} wrap>
            {check.suggestions.map((cutJobId) => (
              <Button
                key={cutJobId}
                size="small"
                type="link"
                onClick={() => onPick(cutJobId)}
              >
                №{cutJobId}
              </Button>
            ))}
          </Space>
        )}
      </Space>
    );
  }
  return null;
}

async function checkRequestedCutJobNumber(cutJobId: number): Promise<CutJobNumberCheck> {
  const exists = await cutJobExists(cutJobId);
  if (!exists) {
    return { status: 'available', suggestions: [] };
  }
  return {
    status: 'duplicate',
    suggestions: await suggestAvailableCutJobNumbers(cutJobId),
    message: `Задание №${cutJobId} уже существует`,
  };
}

async function suggestAvailableCutJobNumbers(cutJobId: number): Promise<number[]> {
  const candidates = Array.from({ length: 30 }, (_item, index) => cutJobId + index + 1);
  const checked = await Promise.all(candidates.map(async (candidate) => (
    await cutJobExists(candidate) ? null : candidate
  )));
  return checked.filter((candidate): candidate is number => candidate !== null).slice(0, 5);
}

async function cutJobExists(cutJobId: number): Promise<boolean> {
  const jobs = await cutApi.list({ jobNumber: String(cutJobId) });
  return jobs.some((job) => normalizeDisplayNumberForCompare(job.displayNumber) === String(cutJobId));
}

function suggestedCutJobIdsFromErrorDetails(details: unknown): number[] {
  if (!details || typeof details !== 'object') return [];
  const raw = (details as { suggestedCutJobIds?: unknown }).suggestedCutJobIds;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .slice(0, 5);
}

function dedupeCommentPresets(presets: SvgCommentPresetOption[]): SvgCommentPresetOption[] {
  const seen = new Set<string>();
  const result: SvgCommentPresetOption[] = [];
  for (const preset of presets) {
    const key = normalizeManualSvgCommentForSubmit(preset.commentText).toLocaleLowerCase('ru-RU');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(preset);
  }
  return result;
}

function appendCommentPreset(current: string, preset: string): string {
  const base = normalizeManualSvgCommentInput(current).replace(/[ \t]+$/u, '');
  const segment = preset.trimStart();
  if (!base) return segment;
  return base.endsWith('\n') ? `${base}${segment}` : `${base} ${segment}`;
}

function appendCommentLineBreak(current: string): string {
  const base = normalizeManualSvgCommentInput(current).replace(/[ \t]+$/u, '');
  return base && !base.endsWith('\n') ? `${base}\n` : base;
}

function normalizeCommentPresetSegment(value: string): string {
  const collapsed = normalizeManualSvgCommentForSubmit(value);
  if (!collapsed) return '';
  if (/[:№]$/u.test(collapsed)) return `${collapsed} `;
  return collapsed;
}

function normalizeManualSvgCommentInput(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trimStart())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n');
}

function normalizeManualSvgCommentForSubmit(value: string): string {
  return normalizeManualSvgCommentInput(value)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function manualSvgUploadSourceFiles(files: Array<ManualSvgUploadFileState | null>): CncTelegramManualSvgUploadFile[] {
  return files
    .filter((file): file is ManualSvgUploadFileState => file !== null)
    .map((file) => file.payload);
}

function manualSvgUploadFilesFingerprint(files: CncTelegramManualSvgUploadFile[]): string {
  return files
    .map((file) => `${file.kind}:${file.fileName}:${file.contentType}:${file.sizeBytes}:${file.sha256}`)
    .sort()
    .join('|');
}

function normalizeManualSvgGeneratedScreenshotContrast(value: number): number {
  if (!Number.isFinite(value)) return MANUAL_SVG_SCREENSHOT_CONTRAST_DEFAULT;
  const clamped = Math.min(MANUAL_SVG_SCREENSHOT_CONTRAST_MAX, Math.max(MANUAL_SVG_SCREENSHOT_CONTRAST_MIN, value));
  return Math.round(clamped * 100) / 100;
}

function manualSvgGeneratedScreenshotContrastKey(value: number, uploadedScreenshot: boolean): string {
  if (uploadedScreenshot) return 'uploaded-screenshot';
  return `generated-screenshot-contrast:${normalizeManualSvgGeneratedScreenshotContrast(value).toFixed(2)}`;
}

function manualSvgScreenshotPreviewFilter(value: number, enabled: boolean): string | undefined {
  if (!enabled) return undefined;
  const contrast = normalizeManualSvgGeneratedScreenshotContrast(value);
  return `contrast(${contrast}) saturate(1.08)`;
}

async function fileToManualSvgUploadFile(
  file: File,
  kind: CncTelegramManualSvgUploadFileKind,
): Promise<CncTelegramManualSvgUploadFile> {
  if (file.size <= 0) throw new Error('Файл пустой');
  if (file.size > MANUAL_SVG_UPLOAD_MAX_FILE_SIZE_BYTES) {
    throw new Error('Файл больше 15 МБ');
  }
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const sha256 = await sha256Hex(buffer);
  return {
    kind,
    fileName: file.name,
    contentType: normalizeManualSvgUploadContentType(file, kind),
    sizeBytes: file.size,
    sha256,
    base64Content: bytesToBase64(bytes),
  };
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Браузер не может посчитать SHA-256 для файла');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function normalizeManualSvgUploadContentType(file: File, kind: CncTelegramManualSvgUploadFileKind): string {
  const type = file.type.trim();
  if (kind === 'svg') return 'image/svg+xml';
  if (kind === 'gcode') return type || 'text/plain';
  if (type === 'image/jpg') return 'image/jpeg';
  return type || screenshotContentTypeFromFileName(file.name) || 'image/png';
}

function screenshotContentTypeFromFileName(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return null;
}

function manualSvgUploadFileKindLabel(kind: CncTelegramManualSvgUploadFileKind): string {
  if (kind === 'svg') return 'SVG';
  if (kind === 'gcode') return 'G-code';
  return 'Скрин';
}

function formatTelegramSendStatus(status: string | null | undefined): string {
  if (status === 'sent') return 'отправлено';
  if (status === 'processing') return 'отправляется';
  if (status === 'pending') return 'в очереди';
  if (status === 'failed') return 'ошибка отправки';
  if (status === 'unknown') return 'статус неизвестен';
  return 'не отправлялось';
}

function createIdempotencyKey(svgContentHash: string): string {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual-svg:${svgContentHash.slice(0, 24)}:${suffix}`;
}

function createPresetIdempotencyKey(commentText: string): string {
  const suffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `manual-svg-preset:${asciiHash(commentText)}:${suffix}`;
}

const SVG_UPLOAD_OTHER_MATERIAL_RE = /(?:^|[^a-zа-яё])(?:hdf|хдф|лдсп|ldsp|lдсп|дсп|dsp|двп|dvp|osb|осп|fanera|фанера|plywood|акрил|acrylic|пластик|plastic)(?=$|[^a-zа-яё])/i;
const SVG_UPLOAD_MDF_MATERIAL_RE = /(?:^|[^a-zа-яё])(?:mdf|мдф)(?=$|[^a-zа-яё])/i;
const SVG_UPLOAD_UNKNOWN_MATERIAL_RE = /^(?:не\s*(?:определ[её]н(?:о)?|распознан(?:о)?)|неизвестн(?:ый|о)?|unknown|[-—])$/i;

function svgUploadMaterialIsInformational(materialName: string | null | undefined, fileName: string | null | undefined): boolean {
  const metadata = [materialName ?? '', fileName ?? ''].filter((value) => value.trim());
  if (metadata.some((value) => SVG_UPLOAD_OTHER_MATERIAL_RE.test(value))) return true;
  const material = materialName?.trim() ?? '';
  if (!material || SVG_UPLOAD_UNKNOWN_MATERIAL_RE.test(material)) return false;
  return !SVG_UPLOAD_MDF_MATERIAL_RE.test(material);
}

function inferMaterialName(items: ParsedSvgUpload['cutLayout']['items'], fileName: string): string | null {
  const fileLower = fileName.toLowerCase();
  if (fileLower.includes('hdf') || fileLower.includes('хдф')) return 'ХДФ';
  if (fileLower.includes('ldsp') || fileLower.includes('лдсп')) return 'ЛДСП';
  if (fileLower.includes('fanera') || fileLower.includes('фанера') || fileLower.includes('plywood')) return 'Фанера';
  if (fileLower.includes('osb') || fileLower.includes('осп')) return 'OSB';
  if (fileLower.includes('dvp') || fileLower.includes('двп')) return 'ДВП';
  if (fileLower.includes('mdf') || fileLower.includes('мдф')) return 'МДФ 16мм';
  return items.length > 0 ? 'МДФ 16мм' : null;
}

function asciiHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
