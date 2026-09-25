import { Table } from '../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Checkbox, Col, Descriptions, Form, Input, InputNumber, Modal, Popconfirm, Row, Select, Space, Tooltip, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { DeleteOutlined, DownloadOutlined, EditOutlined, FilterOutlined, SaveOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { isApiError } from '../../api/apiError';
import {
  bazisCutApi, type BazisCutDetailFields, type BazisCutSetCardDto, type BazisCutSetDetailDto,
} from '../../api/bazisCutApi';
import { OrderDeletedTag, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
import { ExportTemplateSelect } from '../../components/ExportTemplateSelect';
import { useTabStore } from '../../stores/tabStore';
import { can } from '../../utils/permissions';
import { BazisCutCompositionModal, type BazisCutCompositionRequest } from './BazisCutCompositionModal';
import {
  COMPOSITION_INELIGIBLE_TOOLTIP,
  compositionUnavailableText,
  mergeSetAfterMutation,
  needsCompositionReload,
} from './bazisCutComposition';
import {
  buildBazisCutCardPosition,
  buildBazisCutQrCode,
  formatBazisCutAreaM2,
  summarizeBazisCutDetails,
} from './bazisCutDetailPresentation';
import { saveBazisCutFile, type BazisCutSaveHandle } from './bazisCutSaveFile';
import './BazisCutSetPage.css';

const { Title, Text } = Typography;

type FieldKey = keyof BazisCutDetailFields;
interface FieldDefinition { key: FieldKey; label: string; group: 'Основное' | 'Размеры' | 'Кромки' | 'Дополнительно'; kind: 'text' | 'long' | 'number' | 'integer' | 'boolean'; }

const FIELDS: FieldDefinition[] = [
  { key: 'cutEnabled', label: 'Кроить', group: 'Основное', kind: 'boolean' },
  { key: 'materialType', label: 'Тип материала', group: 'Основное', kind: 'text' },
  { key: 'materialName', label: 'Материал', group: 'Основное', kind: 'text' },
  { key: 'materialArticle', label: 'Артикул материала', group: 'Основное', kind: 'text' },
  { key: 'thicknessMm', label: 'Толщина', group: 'Основное', kind: 'number' },
  { key: 'position', label: 'Позиция', group: 'Основное', kind: 'text' },
  { key: 'partName', label: 'Наименования', group: 'Основное', kind: 'text' },
  { key: 'finishedLengthMm', label: 'Длина готовая', group: 'Размеры', kind: 'number' },
  { key: 'finishedWidthMm', label: 'Ширина готовая', group: 'Размеры', kind: 'number' },
  { key: 'cutLengthMm', label: 'Длина распиловочная', group: 'Размеры', kind: 'number' },
  { key: 'cutWidthMm', label: 'Ширина распиловочная', group: 'Размеры', kind: 'number' },
  { key: 'quantity', label: 'Кол-во', group: 'Размеры', kind: 'integer' },
  { key: 'orientation', label: 'Ориентация', group: 'Размеры', kind: 'text' },
  { key: 'groove', label: 'Паз', group: 'Кромки', kind: 'text' },
  { key: 'l1Name', label: 'L1 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'l1Designation', label: 'L1 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'l1ThicknessMm', label: 'L1 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'l2Name', label: 'L2 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'l2Designation', label: 'L2 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'l2ThicknessMm', label: 'L2 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'w1Name', label: 'W1 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'w1Designation', label: 'W1 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'w1ThicknessMm', label: 'W1 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'w2Name', label: 'W2 - Наим.', group: 'Кромки', kind: 'text' },
  { key: 'w2Designation', label: 'W2 - Обозн.', group: 'Кромки', kind: 'text' },
  { key: 'w2ThicknessMm', label: 'W2 - Толщина', group: 'Кромки', kind: 'number' },
  { key: 'priority', label: 'Приоритет', group: 'Дополнительно', kind: 'integer' },
  { key: 'comment', label: 'Комментарий', group: 'Дополнительно', kind: 'long' },
  { key: 'customProperty', label: '%Пользовательское свойство', group: 'Дополнительно', kind: 'long' },
  { key: 'glue', label: '%Склейка', group: 'Дополнительно', kind: 'text' },
  { key: 'milling', label: '%Фрезировка', group: 'Дополнительно', kind: 'text' },
  { key: 'route', label: '%Маршрут', group: 'Дополнительно', kind: 'text' },
  { key: 'film', label: '%Пленка', group: 'Дополнительно', kind: 'text' },
];
const FIELD_GROUPS = ['Основное', 'Размеры', 'Кромки', 'Дополнительно'] as const;
const GROUPED_FIELDS = FIELD_GROUPS.flatMap((group) =>
  FIELDS.filter((field) => field.group === group && field.key !== 'position' && field.key !== 'partName'),
);
type DetailFilterKey = 'source' | 'sourceBazisProjectName' | 'sourceBazisOrderNo' | 'sourceBazisProductName'
  | 'sourceBathCutNumber' | 'qrCode' | FieldKey;
interface DetailFilterDefinition { key: DetailFilterKey; label: string; width: number; }
interface DetailFilterOption { value: string; label: string; }
type DetailFilters = Record<DetailFilterKey, string[]>;
const DETAIL_FILTERS: DetailFilterDefinition[] = [
  { key: 'source', label: 'Источник', width: 180 },
  { key: 'sourceBazisProjectName', label: 'Базис-проект', width: 170 },
  { key: 'sourceBazisOrderNo', label: 'Базис-заказ', width: 160 },
  { key: 'sourceBazisProductName', label: 'Изделие', width: 160 },
  { key: 'sourceBathCutNumber', label: 'Ванна', width: 140 },
  { key: 'qrCode', label: 'QR-code', width: 190 },
  ...FIELDS.map((field) => ({ key: field.key, label: field.label, width: field.kind === 'long' ? 220 : 150 })),
];
const LEADING_COLUMN_COUNT = 9;
const QR_CODE_COLUMN_INDEX = 7;
const QR_CODE_STICKY_CLASS = 'bazis-cut-sticky-qr';
const QR_CODE_STICKY_LEFT_PX = 58 + 210 + 150 + 150;
const DETAIL_SELECTION_COLUMN_WIDTH = 44;
const DETAIL_TABLE_SCROLL_X = 5750;
const EMPTY_DETAIL_FILTER_VALUE = '__bazis_cut_empty_filter__';
const EMPTY_DETAIL_FILTER_LABEL = '—';
const TOTAL_LABEL_COLUMN_INDEX = LEADING_COLUMN_COUNT - 1;
const QUANTITY_COLUMN_INDEX = LEADING_COLUMN_COUNT
  + GROUPED_FIELDS.findIndex((field) => field.key === 'quantity');

export const BazisCutSetPage: React.FC = () => {
  const { id } = useParams(); const setId = Number(id); const valid = Number.isInteger(setId) && setId > 0;
  const [set, setSet] = useState<BazisCutSetCardDto | null>(null);
  const [loading, setLoading] = useState(false); const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false); const [editing, setEditing] = useState<BazisCutSetDetailDto | null>(null);
  const [exportTemplateId, setExportTemplateId] = useState<number>();
  const [exportTemplatesReady, setExportTemplatesReady] = useState(false);
  const [detailFilters, setDetailFilters] = useState<DetailFilters>(() => createEmptyDetailFilters());
  const [detailFiltersOpen, setDetailFiltersOpen] = useState(false);
  const [selectedDetailIds, setSelectedDetailIds] = useState<number[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [quantityEditing, setQuantityEditing] = useState<BazisCutSetDetailDto | null>(null);
  const [compositionRequest, setCompositionRequest] = useState<BazisCutCompositionRequest | null>(null);
  const [nameForm] = Form.useForm<{ name: string }>(); const [detailForm] = Form.useForm<BazisCutDetailFields>();
  const [quantityForm] = Form.useForm<{ quantity: number }>();
  const canManage = can('cut.manage');
  const setTabTitle = useTabStore((state) => state.setTabTitle);
  const tableHeaderOffset = useWorkspaceTabsHeight();

  useEffect(() => {
    if (valid) setTabTitle(`/bazis-cut/${setId}`, `БР #${setId}`);
  }, [setId, setTabTitle, valid]);

  const load = useCallback(async () => {
    if (!valid) return; setLoading(true);
    try { const response = await bazisCutApi.get(setId); setSet(response); nameForm.setFieldsValue({ name: response.name }); }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось загрузить набор'); }
    finally { setLoading(false); }
  }, [nameForm, setId, valid]);
  useEffect(() => { void load(); }, [load]);

  /** Re-fetches the set without the page-level loading spinner; used by the composition
   * modal (preview retry after a stale response, post-confirm reload) and by the legacy
   * detail edit/delete handlers when the backend reports the set switched to the new MDF
   * engine (MDF_COMPOSITION_REQUIRED). */
  const refreshSet = useCallback(async (): Promise<BazisCutSetCardDto | null> => {
    try {
      const response = await bazisCutApi.get(setId);
      setSet(response);
      nameForm.setFieldsValue({ name: response.name });
      return response;
    } catch (error) {
      message.error(errorMessage(error, 'Не удалось обновить набор'));
      return null;
    }
  }, [nameForm, setId]);

  const compositionInfo = set?.mdfComposition ?? null;
  const compositionMode = compositionInfo !== null;
  const compositionAvailable = compositionInfo?.available === true;
  const compositionUnavailableTooltip = useMemo(
    () => compositionUnavailableText(compositionInfo?.reason ?? null),
    [compositionInfo?.reason],
  );
  const eligibleRowIdSet = useMemo(
    () => new Set(compositionInfo?.eligibleRowIds ?? []),
    [compositionInfo?.eligibleRowIds],
  );

  /** Applies a mutation response (rename/updateDetail/removeDetail/…) to page state, working
   * around the backend returning `mdfComposition` on GET responses ONLY (see
   * mergeSetAfterMutation): if composition mode was active before the mutation but the
   * response omitted mdfComposition, this keeps composition-mode controls ACTIVE-but-disabled
   * (never flashing legacy edit/delete controls back) and awaits a GET reload to restore the
   * real, current readiness/eligibility. */
  const applySetMutation = useCallback(async (previous: BazisCutSetCardDto, mutated: BazisCutSetCardDto): Promise<void> => {
    setSet(mergeSetAfterMutation(previous, mutated));
    if (needsCompositionReload(previous, mutated)) await refreshSet();
  }, [refreshSet]);

  const saveName = useCallback(async () => {
    if (!set) return; const { name } = await nameForm.validateFields(); setSaving(true);
    try {
      const result = await bazisCutApi.rename(setId, { name: name.trim(), expectedVersion: set.version }, { idempotencyKey: commandKey('bazis-cut-rename') });
      await applySetMutation(set, result.set);
      message.success('Название сохранено');
    }
    catch (error) { message.error(error instanceof Error ? error.message : 'Не удалось сохранить название'); }
    finally { setSaving(false); }
  }, [applySetMutation, nameForm, set, setId]);

  const startEdit = useCallback((detail: BazisCutSetDetailDto) => { setEditing(detail); detailForm.setFieldsValue(fieldsOf(detail)); }, [detailForm]);
  const saveDetail = useCallback(async () => {
    if (!set || !editing) return; const fields = await detailForm.validateFields(); setSaving(true);
    try { const result = await bazisCutApi.updateDetail(setId, editing.bazisCutSetDetailId,
      { ...fields, priority: fields.priority ?? null, expectedVersion: set.version }, { idempotencyKey: commandKey('bazis-cut-detail') });
      await applySetMutation(set, result.set); setEditing(null); message.success('Строка сохранена'); }
    catch (error) {
      if (isApiError(error, 'MDF_COMPOSITION_REQUIRED')) {
        setEditing(null);
        await refreshSet();
        message.info('Набор перешёл на новый производственный учёт — изменяйте количество и удаляйте детали через предпросмотр состава');
      } else {
        message.error(errorMessage(error, 'Не удалось сохранить строку'));
      }
    }
    finally { setSaving(false); }
  }, [applySetMutation, detailForm, editing, refreshSet, set, setId]);

  const remove = useCallback(async (detailId: number) => {
    if (!set) return;
    try {
      const result = await bazisCutApi.removeDetail(setId, detailId, { expectedVersion: set.version }, { idempotencyKey: commandKey('bazis-cut-delete') });
      await applySetMutation(set, result.set);
      setSelectedDetailIds((current) => current.filter((id) => id !== detailId));
      message.success('Деталь удалена');
    }
    catch (error) {
      if (isApiError(error, 'MDF_COMPOSITION_REQUIRED')) {
        await refreshSet();
        message.info('Набор перешёл на новый производственный учёт — удаляйте детали через предпросмотр состава');
      } else {
        message.error(errorMessage(error, 'Не удалось удалить деталь'));
      }
    }
  }, [applySetMutation, refreshSet, set, setId]);

  const startEditQuantity = useCallback((detail: BazisCutSetDetailDto) => {
    setQuantityEditing(detail);
    quantityForm.setFieldsValue({ quantity: detail.quantity });
  }, [quantityForm]);

  const submitQuantityEdit = useCallback(async () => {
    if (!quantityEditing) return;
    const { quantity } = await quantityForm.validateFields();
    const detail = quantityEditing;
    setQuantityEditing(null);
    if (quantity === detail.quantity) return;
    setCompositionRequest({
      edit: { kind: 'quantity', detailId: detail.bazisCutSetDetailId, quantity },
      summary: `Количество (${buildBazisCutCardPosition(detail) || detail.partName}): ${detail.quantity} → ${quantity}`,
    });
  }, [quantityEditing, quantityForm]);

  const deleteViaComposition = useCallback((detail: BazisCutSetDetailDto) => {
    setCompositionRequest({
      edit: { kind: 'delete', detailId: detail.bazisCutSetDetailId },
      summary: `Удаление: ${buildBazisCutCardPosition(detail) || detail.partName}`,
    });
  }, []);

  const exportXls = useCallback(async () => {
    if (!set) return;
    const picker = (window as PickerWindow).showSaveFilePicker;
    try {
      await saveBazisCutFile({
        suggestedName: exportFileName(set.name, setId),
        picker: picker ? (options) => picker.call(window, options) : undefined,
        fetchFile: () => bazisCutApi.exportXls(setId, exportTemplateId), fallbackDownload: downloadBlob,
        onGenerationStart: () => setExporting(true),
      });
      message.success('Excel-файл сформирован');
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) message.error(error instanceof Error ? error.message : 'Не удалось экспортировать Excel'); }
    finally { setExporting(false); }
  }, [exportTemplateId, set, setId]);

  const details = useMemo(() => set?.details ?? [], [set?.details]);
  const detailFilterOptionsByKey = useMemo(() => buildDetailFilterOptions(details), [details]);
  const filteredDetails = useMemo(() => details.filter((detail) => matchesDetailFilters(detail, detailFilters)), [detailFilters, details]);
  const filteredDetailIds = useMemo(() => filteredDetails.map((detail) => detail.bazisCutSetDetailId), [filteredDetails]);
  /** Filtered ids that may actually be selected for bulk delete: in composition mode, a row
   * not in eligibleRowIds (HDF, non-MDF material, cut-disabled) is never selectable, since
   * the composition command can only ever act on eligible rows. */
  const selectableDetailIds = useMemo(
    () => compositionMode
      ? filteredDetailIds.filter((id) => eligibleRowIdSet.has(String(id)))
      : filteredDetailIds,
    [compositionMode, eligibleRowIdSet, filteredDetailIds],
  );
  const selectedDetailIdSet = useMemo(() => new Set(selectedDetailIds), [selectedDetailIds]);
  const allFilteredSelected = selectableDetailIds.length > 0 && selectableDetailIds.every((id) => selectedDetailIdSet.has(id));
  const someFilteredSelected = selectableDetailIds.some((id) => selectedDetailIdSet.has(id));
  const detailsById = useMemo(() => new Map(details.map((detail) => [detail.bazisCutSetDetailId, detail])), [details]);
  const selectedDetails = useMemo(() => selectedDetailIds
    .map((id) => detailsById.get(id))
    .filter((detail): detail is BazisCutSetDetailDto => Boolean(detail)), [detailsById, selectedDetailIds]);
  const detailFiltersActive = useMemo(() => DETAIL_FILTERS.some((filter) => detailFilters[filter.key].length > 0), [detailFilters]);

  useEffect(() => {
    const availableValues = new Map(DETAIL_FILTERS.map((filter) => [
      filter.key,
      new Set(detailFilterOptionsByKey[filter.key].map((option) => option.value)),
    ]));
    setDetailFilters((current) => {
      let changed = false;
      const next = { ...current };
      for (const filter of DETAIL_FILTERS) {
        const allowed = availableValues.get(filter.key) ?? new Set<string>();
        const kept = current[filter.key].filter((value) => allowed.has(value));
        if (kept.length !== current[filter.key].length) {
          next[filter.key] = kept;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [detailFilterOptionsByKey]);

  useEffect(() => {
    const visibleIds = new Set(selectableDetailIds);
    setSelectedDetailIds((current) => {
      const next = current.filter((id) => visibleIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [selectableDetailIds]);

  const setDetailFilter = useCallback((key: DetailFilterKey, value: string[]) => {
    setDetailFilters((current) => ({ ...current, [key]: value }));
  }, []);

  const removeSelectedDetails = useCallback(async (rows: BazisCutSetDetailDto[]) => {
    if (!set || rows.length === 0) return;
    setBulkDeleting(true);
    let currentSet = set;
    let deleted = 0;
    const failures: string[] = [];
    let compositionRequired = false;
    try {
      for (const row of rows) {
        if (compositionRequired) break;
        try {
          const result = await bazisCutApi.removeDetail(setId, row.bazisCutSetDetailId, { expectedVersion: currentSet.version }, {
            idempotencyKey: commandKey(`bazis-cut-detail-bulk-delete-${row.bazisCutSetDetailId}`),
          });
          currentSet = mergeSetAfterMutation(currentSet, result.set);
          deleted += 1;
        } catch (error) {
          if (isApiError(error, 'MDF_COMPOSITION_REQUIRED')) { compositionRequired = true; break; }
          failures.push(`${buildBazisCutCardPosition(row) || row.partName}: ${errorMessage(error, 'не удалось удалить')}`);
        }
      }
      if (compositionRequired) {
        await refreshSet();
        setSelectedDetailIds((current) => current.filter((id) => !rows.some((row) => row.bazisCutSetDetailId === id)));
        message.info('Набор перешёл на новый производственный учёт — удаляйте детали через предпросмотр состава');
        return;
      }
      setSet(currentSet);
      if (needsCompositionReload(set, currentSet)) await refreshSet();
      setSelectedDetailIds((current) => current.filter((id) => !rows.some((row) => row.bazisCutSetDetailId === id)));
      if (deleted > 0) message.success(`Удалено деталей: ${deleted}`);
      if (failures.length > 0) {
        Modal.error({
          title: 'Не все детали удалены',
          content: <Space direction="vertical" size={4}>
            {failures.slice(0, 6).map((failure) => <Text key={failure}>{failure}</Text>)}
            {failures.length > 6 && <Text type="secondary">Ещё ошибок: {failures.length - 6}</Text>}
          </Space>,
        });
      }
    } finally {
      setBulkDeleting(false);
    }
  }, [refreshSet, set, setId]);

  const confirmRemoveSelectedDetails = useCallback(() => {
    if (selectedDetails.length === 0) return;
    Modal.confirm({
      title: 'Удалить выделенные детали?',
      content: `Будет удалено строк деталей: ${selectedDetails.length}.`,
      okText: 'Удалить',
      cancelText: 'Отмена',
      okButtonProps: { danger: true },
      onOk: () => removeSelectedDetails(selectedDetails),
    });
  }, [removeSelectedDetails, selectedDetails]);

  const bulkDeleteViaComposition = useCallback(() => {
    if (selectedDetails.length === 0) return;
    setCompositionRequest({
      edit: { kind: 'deleteMany', detailIds: selectedDetails.map((detail) => detail.bazisCutSetDetailId) },
      summary: `Удаление выделенных деталей: ${selectedDetails.length}`,
    });
  }, [selectedDetails]);

  const closeCompositionModal = useCallback(() => setCompositionRequest(null), []);
  const onCompositionQueued = useCallback((updatedSet: BazisCutSetCardDto) => {
    setSet(updatedSet);
    const remainingIds = new Set(updatedSet.details.map((detail) => detail.bazisCutSetDetailId));
    setSelectedDetailIds((current) => current.filter((id) => remainingIds.has(id)));
  }, []);

  const rowSelection = useMemo(() => canManage ? {
    selectedRowKeys: selectedDetailIds,
    columnWidth: DETAIL_SELECTION_COLUMN_WIDTH,
    fixed: true,
    columnTitle: <Checkbox aria-label="Выделить все отфильтрованные детали набора"
      checked={allFilteredSelected}
      indeterminate={!allFilteredSelected && someFilteredSelected}
      disabled={bulkDeleting || selectableDetailIds.length === 0}
      onChange={(event) => setSelectedDetailIds(event.target.checked ? selectableDetailIds : [])} />,
    getCheckboxProps: (row: BazisCutSetDetailDto) => {
      const eligible = !compositionMode || eligibleRowIdSet.has(String(row.bazisCutSetDetailId));
      return {
        disabled: bulkDeleting || !eligible,
        title: eligible ? 'Выделить деталь' : COMPOSITION_INELIGIBLE_TOOLTIP,
      };
    },
    onChange: (keys: React.Key[]) => setSelectedDetailIds(keys.filter((key): key is number => typeof key === 'number')),
  } : undefined, [allFilteredSelected, bulkDeleting, canManage, compositionMode, eligibleRowIdSet, selectableDetailIds, selectedDetailIds, someFilteredSelected]);
  const qrCodeStickyLeftPx = QR_CODE_STICKY_LEFT_PX + (rowSelection ? DETAIL_SELECTION_COLUMN_WIDTH : 0);

  const columns = useMemo<ColumnsType<BazisCutSetDetailDto>>(() => buildColumns({
    canManage, compositionMode, compositionAvailable, compositionUnavailableTooltip, eligibleRowIds: eligibleRowIdSet,
    editFields: startEdit, editQuantity: startEditQuantity, removeLegacy: remove, removeComposition: deleteViaComposition,
  }), [canManage, compositionAvailable, compositionMode, compositionUnavailableTooltip, deleteViaComposition, eligibleRowIdSet, remove, startEdit, startEditQuantity]);
  const setTotals = useMemo(() => summarizeBazisCutDetails(details), [details]);
  if (!valid) return <div className="bazis-cut-set-modern"><Alert type="error" showIcon message="Некорректный номер набора" /></div>;
  return <div className="bazis-cut-set-modern"><Space direction="vertical" size="middle" style={{ width: '100%' }}>
    <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}><Title level={3} style={{ margin: 0 }}>Базис-раскрой #{setId}</Title>
      <Space wrap><ExportTemplateSelect targetScreen="bazis_cut_set" sourceType="bazis_cut_set_detail" value={exportTemplateId}
        disabled={exporting} onChange={setExportTemplateId} onReadyChange={setExportTemplatesReady} />
      <Button type="primary" icon={<DownloadOutlined />} loading={exporting} disabled={!set || set.positionCount === 0 || !exportTemplatesReady} onClick={() => void exportXls()}>Экспорт XLS</Button></Space></Space>
    <Card loading={loading} title="Набор"><Form form={nameForm} layout="inline" onFinish={() => void saveName()}>
      <Form.Item name="name" label="Название" rules={[{ required: true, whitespace: true }, { max: 200 }]} style={{ flex: 1 }}><Input disabled={!canManage} /></Form.Item>
      {canManage && <Button htmlType="submit" icon={<SaveOutlined />} loading={saving}>Сохранить</Button>}
    </Form>
    {set && <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} style={{ marginTop: 16 }}>
      <Descriptions.Item label="Сформирован">{new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(set.createdAt))}</Descriptions.Item>
      <Descriptions.Item label="Деталей"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{set.quantity}</span></Descriptions.Item>
      <Descriptions.Item label="Позиций"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{set.positionCount}</span></Descriptions.Item>
      <Descriptions.Item label="Общая площадь"><span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatBazisCutAreaM2(setTotals.totalAreaM2)} м²</span></Descriptions.Item>
      <Descriptions.Item label="ERP-заказы"><SourceRefs refs={set.orders} href={(refId) => `/orders/show/${refId}`} /></Descriptions.Item>
      <Descriptions.Item label="ERP-проекты"><SourceRefs refs={set.projects} /></Descriptions.Item>
      <Descriptions.Item label="Базис-проекты"><SourceRefs refs={set.bazisProjects} href={(refId) => `/bazis/projects/${refId}`} /></Descriptions.Item>
      <Descriptions.Item label="Базис-заказы"><SourceRefs refs={set.bazisOrders} /></Descriptions.Item>
    </Descriptions>}</Card>
    <Card title="Детали набора" extra={<Space wrap>
      <Button icon={<FilterOutlined />} type={detailFiltersOpen || detailFiltersActive ? 'primary' : 'default'}
        aria-expanded={detailFiltersOpen} aria-controls="bazis-cut-detail-filters"
        onClick={() => setDetailFiltersOpen((open) => !open)}>Фильтры</Button>
      {canManage && (compositionMode
        ? (compositionAvailable
          ? <Button danger icon={<DeleteOutlined />} disabled={selectedDetailIds.length === 0}
              onClick={bulkDeleteViaComposition}>Удалить выделенные</Button>
          : <Tooltip title={compositionUnavailableTooltip}><span>
              <Button danger icon={<DeleteOutlined />} disabled>Удалить выделенные</Button>
            </span></Tooltip>)
        : <Button danger icon={<DeleteOutlined />}
            disabled={selectedDetailIds.length === 0 || bulkDeleting}
            loading={bulkDeleting}
            onClick={confirmRemoveSelectedDetails}>Удалить выделенные</Button>)}
    </Space>}><Space direction="vertical" size="small" style={{ width: '100%' }}>
      {detailFiltersOpen && <Space id="bazis-cut-detail-filters" wrap>
          {DETAIL_FILTERS.map((filter) => <Select<string[]> key={filter.key} mode="multiple" allowClear showSearch
            maxTagCount="responsive" value={detailFilters[filter.key]}
            onChange={(values) => setDetailFilter(filter.key, values)}
            options={detailFilterOptionsByKey[filter.key]}
            optionFilterProp="label" notFoundContent="Нет значений"
            disabled={detailFilterOptionsByKey[filter.key].length === 0}
            placeholder={filter.label} aria-label={`Фильтр деталей: ${filter.label}`} style={{ width: filter.width }} />)}
          <Button disabled={!detailFiltersActive} onClick={() => setDetailFilters(createEmptyDetailFilters())}>Сбросить</Button>
      </Space>
      }
      <Space wrap size="small">
        <Text type="secondary">Показано: {filteredDetails.length} из {details.length}</Text>
        {selectedDetailIds.length > 0 && <Text type="secondary">Выбрано: {selectedDetailIds.length}</Text>}
      </Space>
      <Table className="bazis-cut-set-details-table"
        style={{ '--bazis-cut-sticky-qr-left': `${qrCodeStickyLeftPx}px` } as React.CSSProperties}
        rowKey="bazisCutSetDetailId" columns={columns} dataSource={filteredDetails}
        loading={loading} pagination={false} scroll={{ x: DETAIL_TABLE_SCROLL_X + (rowSelection ? DETAIL_SELECTION_COLUMN_WIDTH : 0), y: 480 }} sticky={{ offsetHeader: tableHeaderOffset }}
        rowSelection={rowSelection}
        rowClassName={(row) => orderDeletedReferenceClassName(row.sourceOrderDeleted)}
        summary={(details) => <DetailTableSummary details={details} canManage={canManage} hasSelection={Boolean(rowSelection)} />}
        size="small" locale={{ emptyText: detailFiltersActive ? 'Ничего не найдено' : 'В наборе нет деталей' }} />
    </Space></Card>
  </Space>
  <Modal width={1000} title={`Редактирование позиции ${editing?.position ?? ''}`} open={editing !== null}
    onCancel={() => setEditing(null)} onOk={() => void saveDetail()} confirmLoading={saving} okText="Сохранить" cancelText="Отмена" destroyOnClose>
    <Form form={detailForm} layout="vertical">{FIELD_GROUPS.map((group) => <Card key={group} size="small" title={group} style={{ marginBottom: 12 }}><Row gutter={12}>
      {FIELDS.filter((field) => field.group === group).map((field) => <Col xs={24} md={field.kind === 'long' ? 24 : 8} key={field.key}><FieldInput field={field} /></Col>)}
    </Row></Card>)}</Form>
  </Modal>
  <Modal title={`Изменение количества: ${quantityEditing ? (buildBazisCutCardPosition(quantityEditing) || quantityEditing.partName) : ''}`}
    open={quantityEditing !== null} onCancel={() => setQuantityEditing(null)} onOk={() => void submitQuantityEdit()}
    okText="Далее: предпросмотр" cancelText="Отмена" destroyOnClose>
    <Form form={quantityForm} layout="vertical">
      <Form.Item name="quantity" label="Кол-во" rules={[{ required: true, message: 'Обязательное поле' }]}
        extra="0 удалит деталь из набора (после предпросмотра последствий).">
        <InputNumber style={{ width: '100%' }} min={0} precision={0} />
      </Form.Item>
    </Form>
  </Modal>
  <BazisCutCompositionModal open={compositionRequest !== null} set={set} request={compositionRequest}
    onClose={closeCompositionModal} reload={refreshSet} onQueued={onCompositionQueued} />
  </div>;
};

const FieldInput: React.FC<{ field: FieldDefinition }> = ({ field }) => {
  const rules = field.key === 'materialName' || field.key === 'partName' || field.key === 'materialType'
    ? [{ required: true, message: 'Обязательное поле' }] : [];
  if (field.kind === 'boolean') return <Form.Item name={field.key} label={field.label} valuePropName="checked"><Checkbox>Да</Checkbox></Form.Item>;
  if (field.kind === 'number' || field.kind === 'integer') return <Form.Item name={field.key} label={field.label} rules={rules}>
    <InputNumber style={{ width: '100%' }} precision={field.kind === 'integer' ? 0 : 2} min={field.key === 'priority' || field.key.includes('Thickness') ? 0 : 0.01} /></Form.Item>;
  return <Form.Item name={field.key} label={field.label} rules={rules}>{field.kind === 'long' ? <Input.TextArea rows={2} /> : <Input />}</Form.Item>;
};

interface RowActionsConfig {
  canManage: boolean;
  compositionMode: boolean;
  compositionAvailable: boolean;
  compositionUnavailableTooltip: string;
  /** Rows (by String(bazisCutSetDetailId)) eligible for the composition command; a row NOT
   * in this set (HDF, non-MDF material, cut-disabled) can never be edited/deleted through
   * composition mode, regardless of compositionAvailable. */
  eligibleRowIds: ReadonlySet<string>;
  editFields: (detail: BazisCutSetDetailDto) => void;
  editQuantity: (detail: BazisCutSetDetailDto) => void;
  removeLegacy: (id: number) => void;
  removeComposition: (detail: BazisCutSetDetailDto) => void;
}
function buildColumns(config: RowActionsConfig): ColumnsType<BazisCutSetDetailDto> {
  const { canManage, compositionMode, compositionAvailable, compositionUnavailableTooltip, eligibleRowIds,
    editFields, editQuantity, removeLegacy, removeComposition } = config;
  const valueColumn = (field: FieldDefinition) => ({ title: field.label, dataIndex: field.key, key: field.key, width: field.kind === 'long' ? 220 : 140,
    align: field.kind === 'number' || field.kind === 'integer' ? 'right' as const : undefined,
    render: (value: unknown) => field.kind === 'boolean' ? (value ? 'Да' : 'Нет') : value == null || value === '' ? <Text type="secondary">—</Text> : <span style={{ fontVariantNumeric: field.kind === 'number' || field.kind === 'integer' ? 'tabular-nums' : undefined }}>{String(value)}</span> });
  const grouped = FIELD_GROUPS.map((group) => ({ title: group, children: GROUPED_FIELDS.filter((field) => field.group === group).map(valueColumn) }));
  return [
    { title: '№', key: 'rowNumber', fixed: 'left', width: 58, align: 'right',
      render: (_: unknown, _row: BazisCutSetDetailDto, index: number) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{index + 1}</span> },
    { title: 'Источник', key: 'source', fixed: 'left', width: 210, render: (_, row) => row.sourceOrderId ? (
      <Space size={4} wrap>
        <Link to={`/orders/show/${row.sourceOrderId}`}>{row.sourceOrderName || '—'}</Link>
        <OrderDeletedTag deleted={row.sourceOrderDeleted} />
      </Space>
    ) : 'Снимок' },
    { title: 'Базис-проект', dataIndex: 'sourceBazisProjectName', key: 'sourceBazisProjectName', fixed: 'left', width: 150,
      render: (value: string, row) => value
        ? row.sourceBazisProjectId
          ? <Link to={`/bazis/projects/${row.sourceBazisProjectId}`}><span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span></Link>
          : <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        : <Text type="secondary">—</Text> },
    { title: 'Базис-заказ', dataIndex: 'sourceBazisOrderNo', key: 'sourceBazisOrderNo', fixed: 'left', width: 150,
      render: (value: string) => value
        ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        : <Text type="secondary">—</Text> },
    { title: 'Изделие', dataIndex: 'sourceBazisProductName', key: 'sourceBazisProductName', width: 140,
      render: (value: string) => value || <Text type="secondary">—</Text> },
    { title: 'Ванна', dataIndex: 'sourceBathCutNumber', key: 'sourceBathCutNumber', width: 140,
      render: (value: string) => value
        ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
        : <Text type="secondary">—</Text> },
    { title: 'Позиция', dataIndex: 'position', key: 'position', width: 130,
      render: (_value: string, row) => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{buildBazisCutCardPosition(row)}</span> },
    { title: 'QR-code', key: 'qrCode', className: QR_CODE_STICKY_CLASS, width: 220, render: (_: unknown, row: BazisCutSetDetailDto) => {
      const qrCode = buildBazisCutQrCode(row);
      return qrCode
        ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{qrCode}</span>
        : <Text type="secondary">—</Text>;
    } },
    { title: 'Наименование', dataIndex: 'partName', key: 'partName', width: 200 },
    ...grouped,
    ...(canManage ? [{ title: 'Действия', key: 'actions', fixed: 'right' as const, width: 110,
      render: (_: unknown, row: BazisCutSetDetailDto) => {
        if (!compositionMode) {
          return <Space><Button aria-label="Редактировать" icon={<EditOutlined />} onClick={() => editFields(row)} />
            <Popconfirm title="Удалить деталь из набора?" onConfirm={() => void removeLegacy(row.bazisCutSetDetailId)} okText="Удалить" cancelText="Отмена">
              <Button danger aria-label="Удалить" icon={<DeleteOutlined />} />
            </Popconfirm></Space>;
        }
        const eligible = eligibleRowIds.has(String(row.bazisCutSetDetailId));
        const disabled = !compositionAvailable || !eligible;
        const tooltip = !eligible ? COMPOSITION_INELIGIBLE_TOOLTIP : compositionUnavailableTooltip;
        const buttons = <Space>
          <Button aria-label="Изменить количество" icon={<EditOutlined />} disabled={disabled} onClick={() => editQuantity(row)} />
          <Button danger aria-label="Удалить" icon={<DeleteOutlined />} disabled={disabled} onClick={() => removeComposition(row)} />
        </Space>;
        return disabled
          ? <Tooltip title={tooltip}><span>{buttons}</span></Tooltip>
          : buttons;
      } }] : []),
  ];
}

const DetailTableSummary: React.FC<{
  details: readonly BazisCutSetDetailDto[];
  canManage: boolean;
  hasSelection: boolean;
}> = ({ details, canManage, hasSelection }) => {
  const totals = summarizeBazisCutDetails(details);
  const selectionOffset = hasSelection ? 1 : 0;
  const columnCount = selectionOffset + LEADING_COLUMN_COUNT + GROUPED_FIELDS.length + (canManage ? 1 : 0);
  const qrCodeColumnIndex = selectionOffset + QR_CODE_COLUMN_INDEX;
  const totalLabelColumnIndex = selectionOffset + TOTAL_LABEL_COLUMN_INDEX;
  const quantityColumnIndex = selectionOffset + QUANTITY_COLUMN_INDEX;
  return <Table.Summary fixed="bottom"><Table.Summary.Row style={{ backgroundColor: 'var(--app-surface-muted)' }}>
    {Array.from({ length: columnCount }, (_, index) => <Table.Summary.Cell key={index} index={index}
      className={index === qrCodeColumnIndex ? QR_CODE_STICKY_CLASS : undefined}>
      {index === totalLabelColumnIndex
        ? <div style={{ textAlign: 'right' }}><Text strong>Итого позиций: <span style={{ fontVariantNumeric: 'tabular-nums' }}>{totals.positionCount}</span></Text></div>
        : index === quantityColumnIndex
          ? <div style={{ textAlign: 'right' }}><Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{totals.quantity}</Text></div>
          : null}
    </Table.Summary.Cell>)}
  </Table.Summary.Row></Table.Summary>;
};

function fieldsOf(detail: BazisCutSetDetailDto): BazisCutDetailFields { return Object.fromEntries(FIELDS.map((field) => [field.key, detail[field.key]])) as unknown as BazisCutDetailFields; }
function createEmptyDetailFilters(): DetailFilters {
  return Object.fromEntries(DETAIL_FILTERS.map((filter) => [filter.key, []])) as DetailFilters;
}
function buildDetailFilterOptions(details: readonly BazisCutSetDetailDto[]): Record<DetailFilterKey, DetailFilterOption[]> {
  return Object.fromEntries(DETAIL_FILTERS.map((filter) => [filter.key, buildDetailFilterOptionsForKey(details, filter.key)])) as Record<DetailFilterKey, DetailFilterOption[]>;
}
function buildDetailFilterOptionsForKey(details: readonly BazisCutSetDetailDto[], key: DetailFilterKey): DetailFilterOption[] {
  const options = new Map<string, string>();
  for (const detail of details) {
    const label = detailFilterLabel(detail, key).trim();
    const value = detailFilterOptionValue(label);
    if (!options.has(value)) options.set(value, label === '' ? EMPTY_DETAIL_FILTER_LABEL : label);
  }
  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((left, right) => left.label.localeCompare(right.label, 'ru-RU', { numeric: true, sensitivity: 'base' }));
}
function matchesDetailFilters(detail: BazisCutSetDetailDto, filters: DetailFilters): boolean {
  return DETAIL_FILTERS.every((filter) => {
    const selected = filters[filter.key];
    return selected.length === 0 || selected.includes(detailFilterOptionValue(detailFilterLabel(detail, filter.key)));
  });
}
function detailFilterLabel(detail: BazisCutSetDetailDto, key: DetailFilterKey): string {
  if (key === 'source') return detail.sourceOrderId
    ? detail.sourceOrderName || detail.sourceOrderFullNumber || detail.sourceProjectCode || `Заказ ${detail.sourceOrderId}`
    : 'Снимок';
  if (key === 'qrCode') return buildBazisCutQrCode(detail);
  if (key === 'position') return buildBazisCutCardPosition(detail);
  if (key === 'sourceBazisProjectName' || key === 'sourceBazisOrderNo' || key === 'sourceBazisProductName' || key === 'sourceBathCutNumber') {
    return formatDetailFilterLabel(detail[key]);
  }
  return formatDetailFilterLabel(detail[key]);
}
function formatDetailFilterLabel(value: unknown): string {
  if (value === true) return 'Да';
  if (value === false) return 'Нет';
  if (value == null) return '';
  return String(value);
}
function detailFilterOptionValue(label: string): string {
  const normalized = normalizeDetailFilterText(label);
  return normalized === '' ? EMPTY_DETAIL_FILTER_VALUE : normalized;
}
function normalizeDetailFilterText(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
function commandKey(prefix: string): string { return `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`; }
function useWorkspaceTabsHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const tabs = document.querySelector<HTMLElement>('.workspace-tabs');
    if (!tabs) return;
    const update = () => setHeight(Math.ceil(tabs.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tabs);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  return height;
}
const SourceRefs: React.FC<{ refs: Array<{ id: number; label: string; deleted?: boolean }>; href?: (id: number) => string }> = ({ refs, href }) => {
  if (refs.length === 0) return <>—</>;
  return <>{refs.map((ref, index) => <React.Fragment key={`${ref.id}-${ref.label}`}>{index > 0 && ', '}
    <Space size={4} wrap>
      {href && ref.id > 0 ? <Link to={href(ref.id)}>{ref.label}</Link> : ref.label}
      <OrderDeletedTag deleted={ref.deleted} />
    </Space>
  </React.Fragment>)}</>;
};
function exportFileName(name: string, setId: number): string {
  const safe = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '').slice(0, 120) || 'набор';
  return `Базис-раскрой-${safe}-${setId}.xls`;
}
function downloadBlob(blob: Blob, fileName: string): void { const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
interface PickerWindow extends Window { showSaveFilePicker?: (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<BazisCutSaveHandle>; }
