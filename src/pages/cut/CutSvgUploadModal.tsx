import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Divider,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
} from 'antd';
import type { UploadProps } from 'antd';
import {
  FileAddOutlined,
  LinkOutlined,
  PlusOutlined,
  SaveOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { cncTelegramApi } from '../../api/cncTelegramApi';
import { cutApi } from '../../api/cutApi';
import { ordersApi } from '../../api/ordersApi';
import { isApiError } from '../../api/apiError';
import type { CncTelegramManualSvgCommentPreset } from '../../api/types/cncTelegramApi.types';
import type { EligibleDetailDto } from '../../api/types/cutApi.types';
import type { OrderListItemDto } from '../../api/types/orderApi.types';
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

const EMPTY_DEFAULT_ORDER_IDS: number[] = [];
const EMPTY_DEFAULT_ORDER_NAMES: string[] = [];

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

  const matchSummary = useMemo(() => {
    if (!parsed?.cutLayout.items.length) return null;
    const matched = parsed.cutLayout.items.filter((item) =>
      eligibleDetails.some((detail) => detailMatchesSvgItem(detail, item.orderName, item.detailNumber, item.widthMm, item.heightMm)),
    );
    return {
      matched: matched.length,
      total: parsed.cutLayout.items.length,
      unmatched: parsed.cutLayout.items.length - matched.length,
    };
  }, [eligibleDetails, parsed]);

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
      setEligibleDetails([]);
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
    setRework(false);
    setEligibleDetails([]);
  }, []);

  const submit = useCallback(async () => {
    if (!parsed) {
      message.warning('Загрузите SVG-файл');
      return;
    }
    if (parsed.cutLayout.status !== 'valid') {
      message.error('SVG не прошел валидацию');
      return;
    }
    if (selectedOrderIds.length === 0) {
      message.warning('Укажите заказы для раскроя');
      return;
    }
    if (matchSummary && matchSummary.unmatched > 0) {
      message.warning('Не все детали SVG найдены в выбранных заказах');
      return;
    }

    const idempotencyKey = createIdempotencyKey(parsed.svgContentHash);
    setSubmitting(true);
    try {
      const uploadBody = {
        selectedOrderIds,
        createMdfMachineFileCard: false,
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
      Modal.success({
        title: cutJobId
          ? `Задание на раскрой #${cutJobId} сформировано`
          : 'SVG загружен, требуется проверка раскроя',
        content: cutJobPath ? (
          <Space direction="vertical" size={8}>
            <Button
              type="link"
              icon={<LinkOutlined />}
              onClick={() => {
                Modal.destroyAll();
                navigate(cutJobPath);
              }}
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
      message.error(isApiError(error) ? error.message : 'Не удалось загрузить SVG-раскрой');
    } finally {
      setSubmitting(false);
    }
  }, [
    commentText,
    machineName,
    materialName,
    matchSummary,
    navigate,
    onClose,
    onDone,
    parsed,
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
    try {
      const result = await parseSvgCutUploadFile(file);
      setParsed(result);
      if (result.cutLayout.status === 'valid') {
        const inferredMaterial = inferMaterialName(result.cutLayout.items, result.fileName);
        if (inferredMaterial && !materialName) setMaterialName(inferredMaterial);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось прочитать SVG');
    } finally {
      setParsing(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Загрузка SVG-раскроя"
      width={760}
      onCancel={resetAndClose}
      okText="Сформировать раскрой"
      onOk={() => void submit()}
      confirmLoading={submitting}
      okButtonProps={{
        disabled: !parsed || parsed.cutLayout.status !== 'valid' || selectedOrderIds.length === 0,
        icon: <FileAddOutlined />,
      }}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Upload.Dragger {...uploadProps} disabled={parsing || submitting}>
          <p className="ant-upload-drag-icon"><UploadOutlined /></p>
          <p className="ant-upload-text">SVG-файл раскроя</p>
          <p className="ant-upload-hint">Файл проверяется сразу после выбора</p>
        </Upload.Dragger>

        {parsed && (
          <SvgValidationSummary parsed={parsed} eligibleLoading={eligibleLoading} matchSummary={matchSummary} />
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
    </Modal>
  );
};

function SvgValidationSummary({
  parsed,
  eligibleLoading,
  matchSummary,
}: {
  parsed: ParsedSvgUpload;
  eligibleLoading: boolean;
  matchSummary: { matched: number; total: number; unmatched: number } | null;
}) {
  const layout = parsed.cutLayout;
  const valid = layout.status === 'valid';
  return (
    <Alert
      type={valid ? 'success' : 'error'}
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
