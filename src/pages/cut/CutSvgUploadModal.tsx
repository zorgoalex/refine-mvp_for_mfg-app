import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { UploadProps } from 'antd';
import {
  FileAddOutlined,
  LinkOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { cutApi } from '../../api/cutApi';
import { ordersApi } from '../../api/ordersApi';
import { isApiError, type ApiError } from '../../api/apiError';
import type { CncTelegramManualSvgCommentPreset } from '../../api/types/cncTelegramApi.types';
import type { EligibleDetailDto } from '../../api/types/cutApi.types';
import type { OrderListItemDto } from '../../api/types/orderApi.types';
import { parseSvgCutUploadFileNameHints } from './svgCutUploadFilename';
import { parseSvgCutUploadFile, type ParsedSvgUpload } from './svgCutUploadParser';

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

const EMPTY_DEFAULT_ORDER_IDS: number[] = [];
const EMPTY_DEFAULT_ORDER_NAMES: string[] = [];
const EMPTY_CUT_JOB_NUMBER_CHECK: CutJobNumberCheck = { status: 'idle', suggestions: [] };

const DEFAULT_COMMENT_PRESETS: Array<Pick<CncTelegramManualSvgCommentPreset, 'label' | 'commentText' | 'category'>> = [
  { label: 'Фрезы', commentText: 'фрезы:', category: 'tool' },
  { label: 'Материал', commentText: 'материал:', category: 'material' },
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
    label: defaultOrderNames[index] ? `${defaultOrderNames[index]} · #${orderId}` : `#${orderId}`,
  })), [defaultOrderIdsKey, defaultOrderNamesKey]);
  const [parsed, setParsed] = useState<ParsedSvgUpload | null>(null);
  const [svgPreview, setSvgPreview] = useState<SvgPreviewState | null>(null);
  const svgPreviewUrlRef = useRef<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>(defaultOrderIds);
  const [orderOptions, setOrderOptions] = useState<OrderOption[]>(defaultOrderOptions);
  const [orderSearchLoading, setOrderSearchLoading] = useState(false);
  const [eligibleDetails, setEligibleDetails] = useState<EligibleDetailDto[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [materialName, setMaterialName] = useState('');
  const [machineName, setMachineName] = useState('');
  const [requestedCutJobId, setRequestedCutJobId] = useState<number | null>(null);
  const [cutJobNumberCheck, setCutJobNumberCheck] = useState<CutJobNumberCheck>(EMPTY_CUT_JOB_NUMBER_CHECK);
  const [rework, setRework] = useState(false);
  const [presets, setPresets] = useState<CncTelegramManualSvgCommentPreset[]>([]);
  const [presetSaving, setPresetSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
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
    if (!open || selectedOrderIds.length === 0 || !parsed?.cutLayout.items.length) {
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
  }, [open, parsed, selectedOrderIds]);

  const orderPresetText = useMemo(() => {
    const labels = selectedOrderIds
      .map((orderId) => orderOptions.find((option) => option.value === orderId)?.label ?? `#${orderId}`)
      .map((label) => label.split(' · ')[0]);
    return labels.length > 0 ? `весь заказ: ${labels.join(', ')}` : 'весь заказ';
  }, [orderOptions, selectedOrderIds]);

  const allPresets = useMemo(() => [
    { label: 'Весь заказ', commentText: orderPresetText, category: 'order' },
    ...DEFAULT_COMMENT_PRESETS,
    ...presets,
  ], [orderPresetText, presets]);

  const matchProblems = useMemo(() => {
    if (!parsed?.cutLayout.items.length || eligibleLoading) return [];
    return buildSvgMatchProblems(parsed.cutLayout.items, eligibleDetails);
  }, [eligibleDetails, eligibleLoading, parsed]);

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
  }, []);

  useEffect(() => () => {
    revokeObjectUrl(svgPreviewUrlRef.current);
    svgPreviewUrlRef.current = null;
  }, []);

  const matchSummary = useMemo(() => {
    if (!parsed?.cutLayout.items.length) return null;
    const unmatched = blockingMatchProblems.reduce((sum, problem) => sum + Math.max(1, problem.quantity), 0);
    const matched = parsed.cutLayout.items.length - unmatched;
    return {
      matched,
      total: parsed.cutLayout.items.length,
      unmatched,
    };
  }, [blockingMatchProblems, parsed]);

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
    const comment = value.trim();
    if (!comment) return;
    setCommentText((current) => {
      const lines = current.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.includes(comment)) lines.push(comment);
      return lines.join('\n');
    });
    if (comment.toLowerCase().includes('переделка')) setRework(true);
    if (comment.toLowerCase().startsWith('материал:')) {
      setMaterialName(comment.split(':').slice(1).join(':').trim());
    }
  }, []);

  const savePreset = useCallback(async () => {
    const firstLine = commentText.split('\n').map((line) => line.trim()).find(Boolean);
    if (!firstLine) {
      message.warning('Нет комментария для пресета');
      return;
    }
    setPresetSaving(true);
    try {
      const preset = await cncTelegramApi.createManualSvgCommentPreset({
        label: firstLine.slice(0, 80),
        commentText: firstLine,
        category: rework ? 'rework' : 'custom',
      }, createPresetIdempotencyKey(firstLine));
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
    if (parsed.cutLayout.status !== 'valid') {
      message.error(`SVG не прошел валидацию: ${parsed.cutLayout.reasons.join('; ') || 'нет деталей для раскроя'}`);
      return;
    }
    if (selectedOrderIds.length === 0) {
      message.warning('Укажите заказы для раскроя');
      return;
    }
    if (eligibleLoading) {
      message.warning('Дождитесь проверки деталей выбранных заказов');
      return;
    }
    if (blockingMatchProblems.length > 0) {
      showSvgMatchProblems(blockingMatchProblems);
      return;
    }
    if (requestedCutJobId !== null && cutJobNumberCheck.status !== 'available') {
      message.warning(cutJobNumberCheck.status === 'duplicate'
        ? 'Выберите свободный номер задания'
        : 'Дождитесь проверки номера задания');
      return;
    }
    if (warningMatchProblems.length > 0 && !await confirmSvgMatchWarnings(warningMatchProblems)) {
      return;
    }

    const idempotencyKey = createIdempotencyKey(parsed.svgContentHash);
    setSubmitting(true);
    try {
      const uploadBody = {
        selectedOrderIds,
        createMdfMachineFileCard: false,
        requestedCutJobId,
        svgContentHash: parsed.svgContentHash,
        machine: machineName.trim() || null,
        programName: parsed.fileName,
        materialName: materialName.trim() || null,
        rework,
        comments: commentText.split('\n').map((line) => line.trim()).filter(Boolean),
        parserVersion: 'erp-manual-svg-upload-v1',
        cutLayout: parsed.cutLayout,
        items: parsed.items,
      };
      const response = await cncTelegramApi.manualSvgUpload(uploadBody, idempotencyKey);

      const cutJobId = response.cutJobId;
      const cutJobPath = response.cutJobPath ?? (cutJobId ? `/cut?job=${cutJobId}` : null);
      let mdfCardCreated = false;
      if (cutJobId && await askCreateMdfMachineFileCard()) {
        const mdfResponse = await cncTelegramApi.manualSvgUpload({
          ...uploadBody,
          createMdfMachineFileCard: true,
        }, createIdempotencyKey(`${parsed.svgContentHash}:mdf-card`));
        mdfCardCreated = mdfResponse.createdMdfMachineFileCard;
      }
      const openCutJob = cutJobPath
        ? () => {
            Modal.destroyAll();
            navigate(cutJobPath);
          }
        : undefined;
      Modal.success({
        title: cutJobId
          ? `Задание на раскрой #${cutJobId} сформировано`
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
              Открыть задание #{cutJobId}
            </Button>
            {mdfCardCreated && (
              <Typography.Text type="success">
                Карточка файла станка создана для Доски МДФ
              </Typography.Text>
            )}
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
    machineName,
    materialName,
    matchSummary,
    blockingMatchProblems,
    warningMatchProblems,
    eligibleLoading,
    navigate,
    onClose,
    onDone,
    parsed,
    cutJobNumberCheck.status,
    requestedCutJobId,
    resetFormState,
    rework,
    selectedOrderIds,
  ]);

  const resetAndClose = useCallback(() => {
    resetFormState();
    onClose();
  }, [onClose, resetFormState]);

  async function handleFile(file: File) {
    setParsing(true);
    replaceSvgPreview(createSvgPreview(file));
    try {
      const result = await parseSvgCutUploadFile(file);
      setParsed(result);
      const fileNameHints = parseSvgCutUploadFileNameHints(result.fileName);
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

  return (
    <Modal
      open={open}
      title="Загрузка SVG-раскроя"
      width={1040}
      onCancel={resetAndClose}
      okText="Сформировать раскрой"
      onOk={() => void submit()}
      confirmLoading={submitting}
      okButtonProps={{
        disabled: !parsed || parsed.cutLayout.status !== 'valid' || selectedOrderIds.length === 0 || eligibleLoading || cutJobNumberSubmitBlocked,
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
              eligibleLoading={eligibleLoading}
              matchSummary={matchSummary}
              matchProblems={matchProblems}
            />
          )}

          <Form layout="vertical">
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
              </Space>
            </Form.Item>

            <Form.Item label="Комментарии">
              <Input.TextArea
                value={commentText}
                onChange={(event) => setCommentText(event.target.value)}
                autoSize={{ minRows: 3, maxRows: 6 }}
                placeholder="весь заказ, фрезы, материал, переделка"
              />
            </Form.Item>
            <Button
              icon={<SaveOutlined />}
              loading={presetSaving}
              onClick={() => void savePreset()}
            >
              Сохранить первый комментарий как пресет
            </Button>
          </Form>
        </Space>

        <SvgUploadPreview preview={svgPreview} parsed={parsed} />
      </div>
    </Modal>
  );
};

function SvgUploadPreview({
  preview,
  parsed,
}: {
  preview: SvgPreviewState | null;
  parsed: ParsedSvgUpload | null;
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
        }}
      >
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
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#fafafa',
          padding: 8,
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
            }}
          />
        ) : (
          <Typography.Text type="secondary">Выберите SVG-файл</Typography.Text>
        )}
      </div>
      <div
        style={{
          padding: '8px 12px',
          borderTop: '1px solid #f0f0f0',
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {sheetSize ?? 'Пропорции сохраняются при показе'}
        </Typography.Text>
      </div>
    </div>
  );
}

function createSvgPreview(file: File): SvgPreviewState | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  return {
    url: URL.createObjectURL(file),
    fileName: file.name,
  };
}

function revokeObjectUrl(url: string | null): void {
  if (!url || typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return;
  URL.revokeObjectURL(url);
}

function SvgValidationSummary({
  parsed,
  eligibleLoading,
  matchSummary,
  matchProblems,
}: {
  parsed: ParsedSvgUpload;
  eligibleLoading: boolean;
  matchSummary: { matched: number; total: number; unmatched: number } | null;
  matchProblems: SvgMatchProblem[];
}) {
  const layout = parsed.cutLayout;
  const valid = layout.status === 'valid';
  const errorCount = matchProblems.filter((problem) => problem.severity === 'error').length;
  const warningCount = matchProblems.length - errorCount;
  return (
    <Alert
      type={!valid || errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'success'}
      showIcon
      message={valid ? 'SVG прошел базовую проверку' : 'SVG не прошел проверку'}
      description={(
        <Space direction="vertical" size={6}>
          <Space wrap>
            <Tag>{parsed.fileName}</Tag>
            {layout.sheet && <Tag>{layout.sheet.widthMm} x {layout.sheet.heightMm} мм</Tag>}
            <Tag>{layout.acceptedItemCount ?? layout.items.length} деталей</Tag>
            <Tag>{layout.partContourCount ?? 0} контуров</Tag>
            {matchSummary && (
              <Tag color={matchSummary.unmatched ? 'orange' : 'green'}>
                {eligibleLoading ? 'проверка заказов...' : `${matchSummary.matched}/${matchSummary.total} найдены в заказах`}
              </Tag>
            )}
          </Space>
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

function askCreateMdfMachineFileCard(): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: 'создать карточку файла станка для Доски МДФ из раскроя?',
      okText: 'Создать',
      cancelText: 'Не создавать',
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
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
      label: `${order.orderName} · #${order.orderId}`,
    });
  }
  return Array.from(map.values());
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
                #{cutJobId}
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
    message: `Задание #${cutJobId} уже существует`,
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
  try {
    await cutApi.get(cutJobId);
    return true;
  } catch (error) {
    if (isApiError(error) && (error.status === 404 || error.code === 'CUT_JOB_NOT_FOUND')) return false;
    throw error;
  }
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

function inferMaterialName(items: ParsedSvgUpload['cutLayout']['items'], fileName: string): string | null {
  const fileLower = fileName.toLowerCase();
  if (fileLower.includes('hdf') || fileLower.includes('хдф')) return 'ХДФ';
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
