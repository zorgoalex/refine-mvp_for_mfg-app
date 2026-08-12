import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  DatePicker,
  Empty,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CheckOutlined,
  CloseOutlined,
  ColumnHeightOutlined,
  DownloadOutlined,
  EditOutlined,
  FilterOutlined,
  HistoryOutlined,
  MinusOutlined,
  MoreOutlined,
  PlusOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SaveOutlined,
  SearchOutlined,
  UndoOutlined,
  UpOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useNavigation } from '@refinedev/core';
import dayjs, { type Dayjs } from 'dayjs';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import { subscribeCutPdfTemplatesChanged } from '../../api/cutPdfTemplateEvents';
import { ordersApi } from '../../api/ordersApi';
import type { CutParamProfile, CutPdfTemplate, CutSettingRow } from '../../api/cutConfigApi';
import { ApiError } from '../../api/httpClient';
import type { OrderListItemDto } from '../../api/types/orderApi.types';
import { resolveProfileLabel, formatArea, describeCutProfile } from './cutProfileHelpers';
import { jobMaterialTypeIds, partitionSheetOptions, isMixedMaterialSelection, formatSheetOptionLabel } from './cutSheetSelectHelpers';
import {
  applyCutProfileSelection,
  isVacuumTableProfile,
  resolveCutJobLayoutKind,
  resolveSheetAxisOriginForJob,
} from './cutVacuumProfile';
import {
  buildSheetPieceOverlays,
  cutPdfPreviewBlockReason,
  loadNonVacuumSheetAxisOrigin,
  loadSheetAxisOrigin,
  loadSheetOrientationPortrait,
  loadSheetOriginTopLeft,
  saveNonVacuumSheetAxisOrigin,
  saveSheetAxisOrigin,
  saveSheetOrientationPortrait,
  selectVariantSheets,
  shouldShowCutStaleBadge,
} from './cutPreviewHelpers';
import { TableTopScroll } from '../../components/TableTopScroll';
import { OrderDeletedTag, orderDeletedReferenceClassName } from '../../components/OrderDeletedTag';
import { SheetPreview } from './SheetPreview';
import { SheetEditor } from './SheetEditor';
import { CutPdfPreview } from './CutPdfPreview';
import { buildPieceMetaByItemId } from './cutPieceMeta';
import { pushHistory } from './editorHistory';
import { CutSheetLabelGenerateAction, type CutSheetLabelDetailInstance } from './CutSheetLabelGenerateAction';
import { CutSvgUploadModal } from './CutSvgUploadModal';
import { authSession } from '../../api/authSession';
import { useCutDetailLastReady } from '../orders/useCutDetailLastReady';
import { CutJobVersionLines } from '../orders/CutJobVersionLines';
import type {
  CutGroupDto,
  CutJobDto,
  CutJobListFilters,
  CutJobItemDto,
  CutTextureDirection,
  CutResultSummary,
  EligibleDetailDto,
  SheetPlacements,
} from '../../api/types/cutApi.types';
import {
  movesFromSheets,
  calculateBathSheetFilmUsage,
  shouldShowBathMeterGuides,
  validateSheetGroupInvariant,
  validateSheetPlacements,
} from './cutLayoutGeometry';
import type { CutAxisOrigin, ManualViolation } from './cutLayoutGeometry';
import {
  CUT_JOB_PROFILE_FILTER_DEFAULT,
  CUT_JOB_STATUS_FILTER_ALL,
  CUT_JOB_STATUS_FILTER_OPTIONS,
  type CutJobProfileFilter,
  cutJobCounts,
  cutJobSourceLabel,
  cutJobStatusLabel,
  filterJobsByProfile,
  filterJobsByStatus,
  formatCutJobDisplayNumber,
  formatGroupSummary,
  noSheetSpecMessage,
  parseIdCsv,
  parseJobQueryParam,
  parseResultQueryParam,
  pollPdf,
  safeHttpHref,
  selectableDetailIds,
  triggerBlobDownload,
  buildFilmTextureMap,
  pruneEmptySheets,
} from './cutPageHelpers';
import { filmUsageTooltip, formatFilmLinearMeters, totalFilmUsageMeters } from './cutFilmUsage';
import { can } from '../../utils/permissions';
import { useCutSheetTypeOptions } from '../../hooks/useCutSheetTypeOptions';
import { useTabStore } from '../../stores/tabStore';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { emitCutJobReady } from './cutJobEvents';
import {
  OperationalKpi,
  OperationalKpiGrid,
  OperationalPageHeader,
  useOperationalUi,
} from '../../ui-operational/OperationalPrimitives';
const { Panel } = Collapse;

// Built-in fallback preset names (used until the backend config list loads).
const DEFAULT_PRESET_OPTIONS = [
  { value: 'thumb', label: 'thumb' },
  { value: 'screen', label: 'screen' },
  { value: 'print', label: 'print' },
];

const DEFAULT_PDF_TEMPLATE_OPTIONS = [
  { value: 'standard', label: 'Стандартный' },
  { value: 'bath_profiles', label: 'Профили ванны' },
];

const CUT_TEXTURE_DIRECTION_OPTIONS: Array<{ value: CutTextureDirection; label: string }> = [
  { value: 'vertical', label: 'Вертикальное' },
  { value: 'horizontal', label: 'Горизонтальное' },
  { value: 'none', label: 'Отсутствует' },
];

const { Title, Text } = Typography;
const { RangePicker } = DatePicker;

type CutOrderDateRange = [Dayjs, Dayjs];
type CutOrderDateRangeValue = [Dayjs | null, Dayjs | null] | null | undefined;
type CutCriteriaForm = {
  name: string;
  orderDateRange?: CutOrderDateRangeValue;
  orderIds?: string | number[];
  sheetMaterialTypeIds?: number[];
  filmIds?: number[];
};

type CutOrderSelectOption = {
  value: number;
  label: string;
  title: string;
  searchText: string;
};

type CutFilmSelectOption = {
  value: number;
  label: string;
  title: string;
  searchText: string;
};

type CutJobOrderRef = {
  orderId: number;
  orderName: string | null;
  orderDeleted: boolean;
};

type CutPreviewSummaryRow = {
  key: string;
  filmName: string;
  materialName: string;
  positions: number;
  orders: string[];
  details: number;
  area: number;
};

type CutPreviewSummary = {
  groups: CutPreviewSummaryRow[];
  total: CutPreviewSummaryRow;
};

type PdfPreviewState = {
  open: boolean;
  group: CutGroupDto | null;
  title: string;
  loading: boolean;
  url: string | null;
  blob: Blob | null;
  fileName: string | null;
};

const EMPTY_PDF_PREVIEW: PdfPreviewState = {
  open: false,
  group: null,
  title: 'Предпросмотр PDF',
  loading: false,
  url: null,
  blob: null,
  fileName: null,
};

const INELIGIBLE_LABELS: Record<string, string> = {
  deleted: 'Удалена',
  wrong_status: 'Неподходящий статус',
  not_cuttable: 'Нераскраиваемый материал',
  no_sheet_spec: 'Нет спецификации',
};

const STATUS_TAG_COLORS: Record<string, string> = {
  draft: 'default',
  calculating: 'processing',
  ready: 'green',
  failed: 'red',
  archived: 'default',
};

const CUT_JOBS_TABLE_CONTAINER_HEIGHT = 317;
const CUT_DETAIL_PREVIEW_VISIBLE_ROWS = 20;
const CUT_DETAIL_PREVIEW_ROW_HEIGHT = 20;
const CUT_DETAIL_PREVIEW_TABLE_BODY_HEIGHT = CUT_DETAIL_PREVIEW_VISIBLE_ROWS * CUT_DETAIL_PREVIEW_ROW_HEIGHT;
const CUT_JOB_DETAILS_VISIBLE_ROWS = 15;
const CUT_JOB_DETAILS_ROW_HEIGHT = 40;
const CUT_JOB_DETAILS_TABLE_BODY_HEIGHT = CUT_JOB_DETAILS_VISIBLE_ROWS * CUT_JOB_DETAILS_ROW_HEIGHT;
const CUT_DETAIL_SELECTION_COLUMN_WIDTH = 64;
const CUT_CREATE_PREVIEW_ORDER_TINT_COUNT = 8;
const MIN_EDITOR_VIEW_ZOOM = 0.25;
const MAX_EDITOR_VIEW_ZOOM = 1.5;
const EDITOR_VIEW_ZOOM_STEP = 0.25;

const sheetPreviewListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 16,
  marginTop: 8,
};

const cutActionToolbarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
};

// Fixed «Наверх» button: appears as soon as the page has been scrolled
// vertically and stays visible (view mode and manual editor alike). zIndex
// stays below antd modals (1000).
const backToTopFixedStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  zIndex: 900,
};

const pdfTemplatePickerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  minWidth: 260,
};

const pdfTemplateLabelStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
};

function sheetPreviewRotate90(widthMm: number, heightMm: number, portrait: boolean): boolean {
  if (widthMm === heightMm) return false;
  return portrait ? widthMm > heightMm : widthMm < heightMm;
}

function SheetOrientationIcon({ portrait }: { portrait: boolean }): React.ReactElement {
  return (
    <span
      className={`cut-sheet-control-icon cut-sheet-control-icon--${portrait ? 'portrait' : 'landscape'}`}
      aria-hidden="true"
    />
  );
}

function SheetOriginIcon({ axisOrigin }: { axisOrigin: CutAxisOrigin }): React.ReactElement {
  return (
    <span className="cut-sheet-origin-icon" aria-hidden="true">
      <span className={`cut-sheet-origin-dot cut-sheet-origin-dot--${axisOrigin}`} />
    </span>
  );
}

function effectiveSheetOrigin(
  placements: SheetPlacements | undefined,
  legacyOriginTopLeft: boolean,
  axisOrigin: CutAxisOrigin,
): boolean {
  if (axisOrigin === 'bottom-left') return false;
  return placements?.coordinate_contract === 'native_portrait_v1' ? false : legacyOriginTopLeft;
}

function sheetPreviewItemStyle(widthMm: number, heightMm: number, rotate90: boolean): React.CSSProperties {
  const horizontalMm = rotate90 ? heightMm : widthMm;
  const verticalMm = rotate90 ? widthMm : heightMm;
  const ratio = verticalMm > 0 ? horizontalMm / verticalMm : 1;
  const basis = Math.min(520, Math.max(240, Math.round(ratio * 260 + 112)));
  return {
    flex: `0 1 ${basis}px`,
    maxWidth: '100%',
    // Reserve the thumbnail's image-area height so that when a preview reloads
    // (its cache key is bumped by a job version change, e.g. on profile/material
    // change) the row does not momentarily collapse and bounce the page scroll.
    minHeight: Math.round(basis / Math.max(ratio, 0.01)),
  };
}

function groupFilmNames(job: CutJobDto, group: CutGroupDto): string[] {
  const names = new Set<string>();
  for (const item of job.items) {
    if (item.cutGroupId !== group.cutGroupId) continue;
    const name = item.detail?.filmName?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function detailInstancesForSheet(sheet: { placements: SheetPlacements }): CutSheetLabelDetailInstance[] {
  return sheet.placements.pieces
    .map((piece) => {
      const match = /^det-(\d+)$/.exec(piece.item_id);
      const detailId = match ? Number(match[1]) : null;
      return detailId && Number.isInteger(piece.instance) && piece.instance > 0
        ? { detailId, instance: piece.instance }
        : null;
    })
    .filter((value): value is CutSheetLabelDetailInstance => value !== null);
}

function editableSheetsForGroup(group: CutGroupDto): { sheetIndex: number; placements: SheetPlacements }[] {
  return group.manualLayout && !group.manualLayout.isStale
    ? group.manualLayout.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }))
    : group.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }));
}

function cloneEmptySheet(base: SheetPlacements, sheetIndex: number): { sheetIndex: number; placements: SheetPlacements } {
  return {
    sheetIndex,
    placements: {
      ...base,
      pieces: [],
    },
  };
}

function nextSheetIndex(sheets: ReadonlyArray<{ sheetIndex: number }>): number {
  return sheets.reduce((max, sheet) => Math.max(max, sheet.sheetIndex), -1) + 1;
}

/** Revoke every blob object URL in a key->url map (leak guard on reset/unmount). */
const revokeObjectUrls = (map: Record<string, string>): void => {
  Object.values(map).forEach((url) => URL.revokeObjectURL(url));
};

function formatJobMaterialNames(materialNames: string[] | undefined): string {
  const names = (materialNames ?? []).map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names.join(', ') : '—';
}

function defaultCutOrderDateRange(now: Dayjs = dayjs()): CutOrderDateRange {
  return [now, now];
}

function cutDateRangeToCriteria(range: CutOrderDateRangeValue): { dateFrom?: string; dateTo?: string } {
  const from = range?.[0];
  const to = range?.[1];
  if (!from || !to) return {};
  return {
    dateFrom: from.format('YYYY-MM-DD'),
    dateTo: to.format('YYYY-MM-DD'),
  };
}

function parseOrderIdsValue(value: string | number[] | undefined): number[] | undefined {
  if (Array.isArray(value)) {
    const ids = value.filter((id) => Number.isInteger(id) && id > 0);
    return ids.length > 0 ? ids : undefined;
  }
  const ids = parseIdCsv(value ?? '');
  return ids.length > 0 ? ids : undefined;
}

function buildCutOrderOption(order: OrderListItemDto): CutOrderSelectOption {
  const client = order.clientName ? ` · ${order.clientName}` : '';
  const title = `${order.orderName} · ${order.orderDate}${client}`;
  return {
    value: order.orderId,
    label: order.orderName,
    title,
    searchText: title.toLowerCase(),
  };
}

function buildCutFilmOption(film: { filmId: number; name: string }): CutFilmSelectOption {
  return {
    value: film.filmId,
    label: film.name,
    title: film.name,
    searchText: film.name.toLowerCase(),
  };
}

function mergeCutSelectOptions<T extends { value: number }>(base: T[], extra: T[]): T[] {
  const byValue = new Map<number, T>();
  for (const option of base) byValue.set(option.value, option);
  for (const option of extra) byValue.set(option.value, option);
  return [...byValue.values()];
}

function cutJobOrderOptions(job: CutJobDto | null): CutOrderSelectOption[] {
  const byId = new Map<number, CutOrderSelectOption>();
  for (const item of job?.items ?? []) {
    if (byId.has(item.orderId)) continue;
    const label = item.orderName?.trim() || `#${item.orderId}`;
    const title = item.orderDeleted ? `${label} · удалён` : label;
    byId.set(item.orderId, {
      value: item.orderId,
      label,
      title,
      searchText: label.toLowerCase(),
    });
  }
  return [...byId.values()];
}

function cutJobOrderRefs(items: readonly CutJobItemDto[]): CutJobOrderRef[] {
  const byId = new Map<number, CutJobOrderRef>();
  for (const item of items) {
    const label = item.orderName?.trim() || null;
    const existing = byId.get(item.orderId);
    if (existing) {
      if (!existing.orderName && label) existing.orderName = label;
      existing.orderDeleted = existing.orderDeleted || item.orderDeleted === true;
      continue;
    }
    byId.set(item.orderId, {
      orderId: item.orderId,
      orderName: label,
      orderDeleted: item.orderDeleted === true,
    });
  }
  return [...byId.values()].sort((a, b) => {
    const left = a.orderName ?? `#${a.orderId}`;
    const right = b.orderName ?? `#${b.orderId}`;
    return left.localeCompare(right, 'ru', { numeric: true });
  });
}

function cutJobOrderLabel(ref: CutJobOrderRef): string {
  return ref.orderName?.trim() || `#${ref.orderId}`;
}

function formatCutJobCreatedDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = dayjs(value);
  return date.isValid() ? date.format('DD.MM.YYYY') : '—';
}

function formatCutJobCreatedDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = dayjs(value);
  return date.isValid() ? date.format('DD.MM.YYYY HH:mm') : '—';
}

function cutJobCreatedAtSortValue(value: string | null | undefined): number {
  const date = dayjs(value);
  return date.isValid() ? date.valueOf() : 0;
}

function cutJobCreatedAtInRange(value: string | null | undefined, range: CutOrderDateRangeValue): boolean {
  const from = range?.[0];
  const to = range?.[1];
  if (!from && !to) return true;
  const createdAt = dayjs(value);
  if (!createdAt.isValid()) return false;
  if (from && createdAt.isBefore(from.startOf('day'))) return false;
  if (to && createdAt.isAfter(to.endOf('day'))) return false;
  return true;
}

function cutJobMatchesOrderFilter(job: CutJobDto, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  if (!needle) return true;
  return cutJobOrderRefs(job.items).some((ref) =>
    `${ref.orderId} ${ref.orderName ?? ''}`
      .toLocaleLowerCase('ru-RU')
      .includes(needle),
  );
}

function cutJobMatchesSheetMaterial(job: CutJobDto, sheetMaterialTypeId: number | undefined): boolean {
  if (!sheetMaterialTypeId) return true;
  if (job.sheetMaterialTypeId === sheetMaterialTypeId) return true;
  return job.items.some((item) => item.detail?.sheetMaterialTypeId === sheetMaterialTypeId);
}

function CutOrderReference({
  orderId,
  orderName,
  orderDeleted,
  onOpen,
}: {
  orderId: number;
  orderName?: string | null;
  orderDeleted?: boolean | null;
  onOpen: () => void;
}): JSX.Element {
  const label = orderName?.trim() || `#${orderId}`;
  return (
    <Space size={4} wrap>
      <Button type="link" size="small" style={{ padding: 0 }} onClick={onOpen}>
        {label}
      </Button>
      <OrderDeletedTag deleted={orderDeleted} />
    </Space>
  );
}

function CutJobOrderLinks({
  items,
  onOpen,
}: {
  items: readonly CutJobItemDto[];
  onOpen: (orderId: number) => void;
}): JSX.Element {
  const refs = cutJobOrderRefs(items);
  if (refs.length === 0) return <Text type="secondary">—</Text>;
  return (
    <span className="cut-job-order-links">
      {refs.map((ref, index) => (
        <React.Fragment key={ref.orderId}>
          {index > 0 ? <span className="cut-job-order-links__separator">, </span> : null}
          <CutOrderReference
            orderId={ref.orderId}
            orderName={ref.orderName}
            orderDeleted={ref.orderDeleted}
            onOpen={() => onOpen(ref.orderId)}
          />
        </React.Fragment>
      ))}
    </span>
  );
}

function cutJobFilmOptions(job: CutJobDto | null): CutFilmSelectOption[] {
  const byId = new Map<number, CutFilmSelectOption>();
  for (const item of job?.items ?? []) {
    const filmId = item.detail?.filmId;
    if (typeof filmId !== 'number' || !Number.isInteger(filmId) || filmId <= 0 || byId.has(filmId)) continue;
    const label = item.detail?.filmName?.trim() || `Плёнка #${filmId}`;
    byId.set(filmId, {
      value: filmId,
      label,
      title: label,
      searchText: label.toLowerCase(),
    });
  }
  return [...byId.values()];
}

function cutJobSheetTypeOptions(job: CutJobDto | null): Array<{ value: number; label: string }> {
  const byId = new Map<number, { value: number; label: string }>();
  for (const item of job?.items ?? []) {
    const sheetMaterialTypeId = item.detail?.sheetMaterialTypeId;
    if (
      typeof sheetMaterialTypeId !== 'number'
      || !Number.isInteger(sheetMaterialTypeId)
      || sheetMaterialTypeId <= 0
      || byId.has(sheetMaterialTypeId)
    ) continue;
    byId.set(sheetMaterialTypeId, {
      value: sheetMaterialTypeId,
      label: item.detail?.materialName?.trim() || `Тип листа #${sheetMaterialTypeId}`,
    });
  }
  return [...byId.values()];
}

function optionValues(options: Array<{ value: number }>): number[] {
  return options.map((option) => option.value);
}

function cutPreviewOrderTintByOrderId(details: EligibleDetailDto[]): Map<number, number> {
  const byOrderId = new Map<number, number>();
  for (const detail of details) {
    if (byOrderId.has(detail.orderId)) continue;
    byOrderId.set(detail.orderId, byOrderId.size % CUT_CREATE_PREVIEW_ORDER_TINT_COUNT);
  }
  return byOrderId;
}

function cutJobItemOrderTintByOrderId(items: CutJobItemDto[]): Map<number, number> {
  const byOrderId = new Map<number, number>();
  for (const item of items) {
    if (byOrderId.has(item.orderId)) continue;
    byOrderId.set(item.orderId, byOrderId.size % CUT_CREATE_PREVIEW_ORDER_TINT_COUNT);
  }
  return byOrderId;
}

function uniqueNonBlank(values: Array<string | number | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    const text = value == null ? '' : String(value).trim();
    if (text) set.add(text);
  }
  return [...set];
}

function buildSuggestedCutName(details: EligibleDetailDto[], now: Dayjs = dayjs()): string {
  const candidates = details.filter((detail) => detail.eligible);
  const source = candidates.length > 0 ? candidates : details;
  const orders = uniqueNonBlank(source.map((detail) => detail.orderName || `#${detail.orderId}`));
  const films = uniqueNonBlank(source.map((detail) => detail.filmName));
  return `раскрой ${orders.length > 0 ? orders.join(', ') : 'без заказов'} - ${films.length > 0 ? films.join(', ') : 'без пленки'} - ${now.format('DD.MM.YYYY')}`;
}

function cutPreviewOrderLabel(detail: EligibleDetailDto): string {
  return detail.orderName?.trim() || `#${detail.orderId}`;
}

function normalizeCutSummaryLabel(value: string | null | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function cutPreviewAreaTotal(detail: EligibleDetailDto): number {
  const area = Number(detail.area);
  const quantity = Number(detail.quantity);
  if (!Number.isFinite(area) || !Number.isFinite(quantity)) return 0;
  return area * quantity;
}

function buildCutPreviewSummary(details: EligibleDetailDto[]): CutPreviewSummary {
  const groups = new Map<string, Omit<CutPreviewSummaryRow, 'orders'> & { orderSet: Set<string> }>();
  const total: Omit<CutPreviewSummaryRow, 'orders'> & { orderSet: Set<string> } = {
    key: 'total',
    filmName: 'Все плёнки',
    materialName: 'Все материалы',
    positions: 0,
    orderSet: new Set(),
    details: 0,
    area: 0,
  };

  for (const detail of details) {
    const filmName = normalizeCutSummaryLabel(detail.filmName, 'без плёнки');
    const materialName = normalizeCutSummaryLabel(detail.materialName, 'без материала');
    const groupKey = `${detail.filmId ?? filmName}::${detail.sheetMaterialTypeId ?? detail.materialId ?? materialName}`;
    const quantity = Number.isFinite(Number(detail.quantity)) ? Number(detail.quantity) : 0;
    const area = cutPreviewAreaTotal(detail);
    const order = cutPreviewOrderLabel(detail);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        key: groupKey,
        filmName,
        materialName,
        positions: 0,
        orderSet: new Set(),
        details: 0,
        area: 0,
      };
      groups.set(groupKey, group);
    }
    for (const bucket of [group, total]) {
      bucket.positions += 1;
      bucket.orderSet.add(order);
      bucket.details += quantity;
      bucket.area += area;
    }
  }

  const finalize = (row: Omit<CutPreviewSummaryRow, 'orders'> & { orderSet: Set<string> }): CutPreviewSummaryRow => ({
    key: row.key,
    filmName: row.filmName,
    materialName: row.materialName,
    positions: row.positions,
    orders: [...row.orderSet],
    details: row.details,
    area: row.area,
  });

  return {
    groups: [...groups.values()]
      .map(finalize)
      .sort((a, b) => `${a.materialName} ${a.filmName}`.localeCompare(`${b.materialName} ${b.filmName}`, 'ru')),
    total: finalize(total),
  };
}

function formatCutPreviewSummaryMetrics(row: CutPreviewSummaryRow): string {
  const orders = row.orders.length > 0 ? row.orders.join(', ') : '—';
  return `позиций ${row.positions}; заказов ${row.orders.length} (${orders}); деталей ${row.details}; площадь ${formatArea(row.area)}`;
}

function cutDetailCellText(value: unknown): string {
  return value === null || value === undefined || value === '' ? '—' : String(value);
}

function cutDetailColumnWidth<T>(
  rows: T[],
  title: string,
  readValue: (row: T) => unknown,
  options: { min: number; max: number; charWidth?: number; padding?: number },
): number {
  const charWidth = options.charWidth ?? 7;
  const padding = options.padding ?? 28;
  const longest = [title, ...rows.map((row) => cutDetailCellText(readValue(row)))]
    .reduce((max, text) => Math.max(max, text.length), 0);
  return Math.min(options.max, Math.max(options.min, Math.ceil(longest * charWidth + padding)));
}

function tableScrollX<T>(columns: ColumnsType<T>, selectionColumnWidth = 0): number {
  return columns.reduce((total, column) => total + (typeof column.width === 'number' ? column.width : 0), selectionColumnWidth);
}

function cutJobRefProfileLabel(job: { profileName: string | null; profileIsActive: boolean | null }): string {
  if (!job.profileName) return 'По умолчанию';
  return job.profileIsActive === false ? `${job.profileName} (неактивен)` : job.profileName;
}

function cutDetailExistingJobsText(detail: EligibleDetailDto): string {
  const active = (detail.activeJobs ?? []).map((job) => `${job.name} / ${cutJobRefProfileLabel(job)}`);
  const archived = (detail.archivedJobs ?? []).map((job) => `${job.name} / ${cutJobRefProfileLabel(job)} (архив)`);
  const jobs = [...active, ...archived];
  return jobs.length > 0 ? jobs.join(', ') : '—';
}

async function fetchCutOrderOptions(dateFrom: string, dateTo: string): Promise<CutOrderSelectOption[]> {
  const firstPage = await ordersApi.list({
    page: 1,
    pageSize: 200,
    sortBy: 'orderDate',
    sortOrder: 'desc',
    dateFrom,
    dateTo,
  });
  const orders = [...firstPage.data];
  for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
    const nextPage = await ordersApi.list({
      page,
      pageSize: 200,
      sortBy: 'orderDate',
      sortOrder: 'desc',
      dateFrom,
      dateTo,
    });
    orders.push(...nextPage.data);
  }
  return orders.map(buildCutOrderOption);
}

/**
 * Backend-owned /cut page (CLAUDE.md principle 2/3): all reads and commands go
 * through cutApi (`/api/v1/cut-jobs`); the read-layer is never written from here.
 * Flow: criteria -> draft job -> eligible details (no_sheet_spec surfaced) ->
 * basket -> calculate -> per-sheet PNG.
 */
interface CutPageProps {
  embeddedOrderId?: number;
}

export const CutPage: React.FC<CutPageProps> = ({ embeddedOrderId }) => {
  const isOperational = useOperationalUi();
  const canViewCut = can('cut.view');
  const canManage = can('cut.manage');
  const canViewOrders = can('orders.view');
  const isEmbeddedOrder = Number.isInteger(embeddedOrderId) && (embeddedOrderId ?? 0) > 0;
  // Theme-aware bg for the sticky group header (app uses AntD dark/default
  // algorithm, no CSS vars — read the token directly).
  const { token } = theme.useToken();
  // The sticky group header must sit BELOW the global sticky workspace tab-bar
  // (.workspace-tabs, top:0 z-index:20) — otherwise it pins under the tabs and
  // gets obscured. Measure the tab-bar height at runtime (it has a dynamic
  // 20px gap border) and offset the header by it. Falls back to 0 when the cut
  // page is not rendered inside the workspace tabs.
  const [stickyHeaderTop, setStickyHeaderTop] = useState(0);
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    // Attach a ResizeObserver to the tab-bar once it exists. WorkspaceTabs renders
    // null until the current tab is opened (useTabSync), so on a cold /cut load the
    // bar mounts LATE — a one-shot querySelector would miss it and leave the offset
    // at 0 (overlap bug). Watch the DOM until the bar appears, then measure + observe.
    const attach = (): boolean => {
      const tabs = document.querySelector('.workspace-tabs');
      if (!tabs) return false;
      const measure = () => setStickyHeaderTop(tabs.getBoundingClientRect().height);
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(tabs);
      return true;
    };
    if (attach()) return () => ro?.disconnect();
    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);
  // Variant B Task 11: cut.view-gated sheet-type options for the filter Select.
  // Gated on cut.view only — no sheet_materials.view required (worker can use filter).
  const { enabled: sheetFilterEnabled, options: sheetTypeOptions, rawOptions: sheetOptions } = useCutSheetTypeOptions();
  // Open orders inside the app's keep-alive workspace tabs (same as the orders
  // list double-click), not a new browser tab.
  const { show } = useNavigation();
  const [form] = Form.useForm<CutCriteriaForm>();
  const defaultOrderDateRange = useMemo(defaultCutOrderDateRange, []);
  const watchedOrderDateRange = Form.useWatch('orderDateRange', form) as CutOrderDateRangeValue;
  const watchedOrderIds = Form.useWatch('orderIds', form) as CutCriteriaForm['orderIds'];
  const watchedSheetMaterialTypeIds = Form.useWatch('sheetMaterialTypeIds', form) as number[] | undefined;
  const orderDateCriteria = cutDateRangeToCriteria(watchedOrderDateRange ?? defaultOrderDateRange);
  const orderDateFrom = orderDateCriteria.dateFrom;
  const orderDateTo = orderDateCriteria.dateTo;
  const [job, setJob] = useState<CutJobDto | null>(null);
  const [isEditingJobName, setIsEditingJobName] = useState(false);
  const [jobNameDraft, setJobNameDraft] = useState('');
  const [jobNameSaving, setJobNameSaving] = useState(false);
  const [selectedResult, setSelectedResult] = useState<CutResultSummary | null>(null);
  const [isFrozenResultSelection, setIsFrozenResultSelection] = useState(false);
  const calcCommandRef = useRef<{ cutJobId: number; version: number; commandId: string } | null>(null);
  const manualCommandRef = useRef<{ key: string; commandId: string } | null>(null);
  const isHistoricalResult = selectedResult !== null && isFrozenResultSelection;
  const pdfTemplateIsRequestOnly = isHistoricalResult || job?.status === 'archived';
  const [profiles, setProfiles] = useState<CutParamProfile[]>([]);
  const rawJobCalculatedEngine = job?.groups.find(
    (group) => group.summary?.engine_used,
  )?.summary?.engine_used;
  const jobCalculatedEngine = typeof rawJobCalculatedEngine === 'string'
    ? rawJobCalculatedEngine
    : undefined;
  const jobDisplayNumber = job ? formatCutJobDisplayNumber(job, profiles) : null;
  // Per-user, per-job sheet preview orientation, persisted in localStorage.
  // Vacuum-table jobs default to landscape; other profiles default to portrait.
  // Landscape rotates the render server-side (labels stay upright).
  const [sheetPortrait, setSheetPortrait] = useState(true);
  // Per-user, per-job origin anchor for the rotated (portrait) render: when true
  // (default) the dense cluster sits at the view's top-left (transpose); when
  // false it keeps the legacy 90° CW top-right. Persisted in localStorage.
  const [sheetOriginTopLeft, setSheetOriginTopLeft] = useState(true);
  const [sheetAxisOrigin, setSheetAxisOrigin] = useState<CutAxisOrigin>('top-left');
  const [eligible, setEligible] = useState<EligibleDetailDto[] | null>(null);
  const [noSheetSpecCount, setNoSheetSpecCount] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [previewName, setPreviewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheetImages, setSheetImages] = useState<Record<string, string>>({});
  // Auto-loaded small layout previews (preset 'thumb') for a ready job's sheets,
  // keyed `${cutGroupId}:${sheetIndex}`. thumbReqRef dedupes in-flight/done fetches.
  const [sheetThumbs, setSheetThumbs] = useState<Record<string, string>>({});
  const thumbReqRef = useRef<Set<string>>(new Set());
  // Generation counter bumped on every job-context switch/reset; an async sheet
  // fetch captures it and discards its result if it changed (job switched).
  const viewEpochRef = useRef(0);
  // Mirror of the live blob maps so the unmount cleanup (stale-closure-safe) can
  // revoke any outstanding object URLs even though /cut is kept mounted.
  const blobsRef = useRef<{ images: Record<string, string>; thumbs: Record<string, string> }>({
    images: {},
    thumbs: {},
  });

  // Clear both per-sheet view caches, revoking blob URLs so a recalculated or
  // reopened job never shows a stale preview and never leaks blobs.
  const resetSheetViews = useCallback(() => {
    setSheetImages((prev) => {
      revokeObjectUrls(prev);
      return {};
    });
    setSheetThumbs((prev) => {
      revokeObjectUrls(prev);
      return {};
    });
    thumbReqRef.current = new Set();
    // Invalidate in-flight sheet/thumb fetches so a late completion can't
    // repopulate the just-cleared maps with a stale-job blob.
    viewEpochRef.current += 1;
  }, []);

  // Collapse a single full-size sheet back to its thumbnail: revoke the full
  // image blob and drop it from the map (the thumb stays; clicking reopens).
  const collapseSheet = useCallback((key: string) => {
    setSheetImages((prev) => {
      if (!prev[key]) return prev;
      URL.revokeObjectURL(prev[key]);
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Load this user's saved orientation + origin for the opened job. Vacuum-table
  // jobs retain their axis preference. Every non-vacuum job migrates to top-left
  // once, including old jobs; an explicit choice made afterwards is retained.
  useEffect(() => {
    if (!job) return;
    const uid = authSession.getUser()?.id ?? 'anon';
    setSheetPortrait(loadSheetOrientationPortrait(
      uid,
      job.cutJobId,
      !isVacuumTableProfile(job.paramProfileId, profiles),
    ));
    setSheetOriginTopLeft(loadSheetOriginTopLeft(uid, job.cutJobId));
    const savedNonVacuumAxisOrigin = loadNonVacuumSheetAxisOrigin(uid, job.cutJobId);
    const nextAxisOrigin = resolveSheetAxisOriginForJob(
      job.paramProfileId,
      profiles,
      loadSheetAxisOrigin(uid, job.cutJobId),
      jobCalculatedEngine,
      savedNonVacuumAxisOrigin,
      isHistoricalResult,
    );
    setSheetAxisOrigin(nextAxisOrigin);
    if (
      savedNonVacuumAxisOrigin === null
      && resolveCutJobLayoutKind(
        job.paramProfileId,
        profiles,
        jobCalculatedEngine,
        isHistoricalResult,
      ) === 'non-vacuum'
    ) {
      saveNonVacuumSheetAxisOrigin(uid, job.cutJobId, nextAxisOrigin);
    }
  }, [isHistoricalResult, job?.cutJobId, job?.paramProfileId, jobCalculatedEngine, profiles]);

  useEffect(() => {
    if (!job) {
      setIsEditingJobName(false);
      setJobNameDraft('');
      return;
    }
    setIsEditingJobName(false);
    setJobNameDraft(job.name);
  }, [job?.cutJobId]);

  useEffect(() => {
    if (job && !isEditingJobName) setJobNameDraft(job.name);
  }, [isEditingJobName, job?.name]);

  // Toggle + persist orientation; drop cached previews so they re-fetch oriented.
  const toggleSheetPortrait = useCallback(
    (portrait: boolean) => {
      setSheetPortrait(portrait);
      if (job) {
        const uid = authSession.getUser()?.id ?? 'anon';
        saveSheetOrientationPortrait(uid, job.cutJobId, portrait);
      }
      resetSheetViews();
    },
    [job, resetSheetViews],
  );

  // Toggle + persist origin anchor; like the orientation toggle, origin is NOT a
  // local blob-cache key dimension, so drop ALL cached previews (revoke blobs +
  // bump epoch + clear thumb dedup) so stale opposite-origin PNGs/thumbs cannot
  // linger on screen and every sheet re-fetches with the new `origin=` URL.
  const changeSheetAxisOrigin = useCallback(
    (axisOrigin: CutAxisOrigin) => {
      setSheetAxisOrigin(axisOrigin);
      if (job) {
        const uid = authSession.getUser()?.id ?? 'anon';
        const layoutKind = resolveCutJobLayoutKind(
          job.paramProfileId,
          profiles,
          jobCalculatedEngine,
          isHistoricalResult,
        );
        if (layoutKind === 'non-vacuum') {
          saveNonVacuumSheetAxisOrigin(uid, job.cutJobId, axisOrigin);
        } else {
          saveSheetAxisOrigin(uid, job.cutJobId, axisOrigin);
        }
      }
      resetSheetViews();
    },
    [isHistoricalResult, job, jobCalculatedEngine, profiles, resetSheetViews],
  );

  useEffect(() => {
    blobsRef.current = { images: sheetImages, thumbs: sheetThumbs };
  }, [sheetImages, sheetThumbs]);
  useEffect(
    () => () => {
      revokeObjectUrls(blobsRef.current.images);
      revokeObjectUrls(blobsRef.current.thumbs);
    },
    [],
  );
  const [preset, setPreset] = useState<string>('screen');
  const [presetOptions, setPresetOptions] = useState(DEFAULT_PRESET_OPTIONS);
  const [pdfTemplateOptions, setPdfTemplateOptions] = useState(DEFAULT_PDF_TEMPLATE_OPTIONS);
  const [pdfTemplateForJob, setPdfTemplateForJob] = useState('standard');
  const [cutSettings, setCutSettings] = useState<CutSettingRow[]>([]);
  const [jobs, setJobs] = useState<CutJobDto[]>([]);
  const [embeddedJobIds, setEmbeddedJobIds] = useState<Set<number> | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>(CUT_JOB_STATUS_FILTER_ALL);
  const [profileFilter, setProfileFilter] = useState<CutJobProfileFilter>();
  const [jobSearch, setJobSearch] = useState('');
  const [jobOrderSearch, setJobOrderSearch] = useState('');
  const [appliedJobOrderSearch, setAppliedJobOrderSearch] = useState('');
  const [appliedCutListDateRange, setAppliedCutListDateRange] = useState<CutOrderDateRangeValue>(undefined);
  const [operationalSheetFilter, setOperationalSheetFilter] = useState<number | undefined>();
  const [operationalFilmFilter, setOperationalFilmFilter] = useState<number | undefined>();
  const [cutListDateRange, setCutListDateRange] = useState<CutOrderDateRangeValue>(undefined);
  const [svgUploadOpen, setSvgUploadOpen] = useState(false);
  const listFiltersRef = useRef<CutJobListFilters>({});
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [orderOptions, setOrderOptions] = useState<CutOrderSelectOption[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const orderOptionsSeqRef = useRef(0);
  const [filmOptions, setFilmOptions] = useState<CutFilmSelectOption[]>([]);
  const [filmsLoading, setFilmsLoading] = useState(false);
  const filmOptionsSeqRef = useRef(0);
  const currentJobOrderOptions = useMemo(() => cutJobOrderOptions(job), [job]);
  const currentJobFilmOptions = useMemo(() => cutJobFilmOptions(job), [job]);
  const currentJobSheetTypeOptions = useMemo(() => cutJobSheetTypeOptions(job), [job]);
  const visibleOrderOptions = useMemo(
    () => mergeCutSelectOptions(orderOptions, currentJobOrderOptions),
    [currentJobOrderOptions, orderOptions],
  );
  const visibleFilmOptions = useMemo(
    () => mergeCutSelectOptions(filmOptions, currentJobFilmOptions),
    [currentJobFilmOptions, filmOptions],
  );
  const visibleSheetTypeOptions = useMemo(
    () => mergeCutSelectOptions(sheetTypeOptions, currentJobSheetTypeOptions),
    [currentJobSheetTypeOptions, sheetTypeOptions],
  );
  const jobProfileFilterOptions = useMemo(() => {
    const knownProfileIds = new Set(profiles.map((profile) => profile.cutParamProfileId));
    const historicalProfileIds = [...new Set(
      jobs
        .map((candidate) => candidate.paramProfileId)
        .filter((profileId): profileId is number => profileId !== null && !knownProfileIds.has(profileId)),
    )].sort((a, b) => a - b);
    return [
      { value: CUT_JOB_PROFILE_FILTER_DEFAULT, label: 'По умолчанию' },
      ...profiles.map((profile) => ({
        value: profile.cutParamProfileId,
        label: resolveProfileLabel(profile.cutParamProfileId, profiles, cutSettings),
      })),
      ...historicalProfileIds.map((profileId) => ({
        value: profileId,
        label: resolveProfileLabel(profileId, profiles, cutSettings),
      })),
    ];
  }, [cutSettings, jobs, profiles]);

  // ── Manual layout editor state ──────────────────────────────────────────────
  // The group currently open for editing (null = no editor active).
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  // Working sheets for the active editor (seeded from manualLayout or auto sheets).
  const [workingSheets, setWorkingSheets] = useState<{ sheetIndex: number; placements: SheetPlacements }[]>([]);
  // Current geometry violations (empty = all clear, save enabled).
  const [violations, setViolations] = useState<ManualViolation[]>([]);
  const [editorViewZoom, setEditorViewZoom] = useState(1);
  const [editorSheetRotations, setEditorSheetRotations] = useState<Record<number, number>>({});
  const [editorSheetMirrors, setEditorSheetMirrors] = useState<Record<number, { horizontal: boolean; vertical: boolean }>>({});
  // Undo stack of workingSheets snapshots (one per committed drag/rotate),
  // capped at EDITOR_UNDO_LIMIT. Cleared on enter/cancel/save.
  const [editorHistory, setEditorHistory] = useState<{ sheetIndex: number; placements: SheetPlacements }[][]>([]);
  // «Наверх» visibility: shown as soon as the page has vertical scroll offset.
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    // User requirement: the button appears as soon as ANY vertical scroll is
    // engaged (not after a threshold), and hides again at the very top.
    const onScroll = () => setShowBackToTop(window.scrollY > 0);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * Scroll back to the relevant group header: the group being edited, else the
   * group card the viewport is currently inside (nearest header at/above the
   * top edge), else the page top.
   */
  const scrollBackToGroupTop = useCallback(() => {
    let targetId: number | null = editingGroupId;
    if (targetId == null) {
      // A card whose header is at/above the measured sticky stack is the one
      // the viewport is currently inside; among those take the lowest. Use the
      // dynamic stickyHeaderTop (not a literal) + a small tolerance so the
      // heuristic tracks whatever the workspace chrome actually occupies.
      const viewportTopEdge = stickyHeaderTop + 16;
      let bestTop = Number.NEGATIVE_INFINITY;
      for (const g of job?.groups ?? []) {
        const el = document.getElementById(`cut-group-card-${g.cutGroupId}`);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= viewportTopEdge && top > bestTop) {
          bestTop = top;
          targetId = g.cutGroupId;
        }
      }
    }
    const el = targetId != null ? document.getElementById(`cut-group-card-${targetId}`) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [editingGroupId, job, stickyHeaderTop]);
  // Per-group alternative-view toggle: true = show manual variant, false = show auto.
  // Initialised from group.manualLayout.isActive on job open; only persisted on Save.
  const [showAlternativeByGroup, setShowAlternativeByGroup] = useState<Record<number, boolean>>({});
  const [pdfTemplateByGroup, setPdfTemplateByGroup] = useState<Record<number, string>>({});
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState>(EMPTY_PDF_PREVIEW);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestSeqRef = useRef(0);

  const revokePdfPreviewUrl = useCallback(() => {
    if (pdfPreviewUrlRef.current) {
      URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
    }
  }, []);

  useEffect(() => () => revokePdfPreviewUrl(), [revokePdfPreviewUrl]);

  const applyPdfTemplateState = useCallback((nextJob: CutJobDto | null) => {
    if (!nextJob) {
      setPdfTemplateForJob('standard');
      setPdfTemplateByGroup({});
      return;
    }
    setPdfTemplateForJob(nextJob.pdfTemplate ?? 'standard');
    setPdfTemplateByGroup(Object.fromEntries(nextJob.groups.map((group) => [group.cutGroupId, group.pdfTemplate ?? 'standard'])));
  }, []);

  // Render presets and cut profiles are config-driven (/configuration "Раскрой").
  // Load active names from the backend, falling back to the built-ins.
  const loadCutConfig = useCallback(async () => {
    try {
      const cfg = await cutConfigApi.get();
      const options = cfg.renderPresets
        .filter((p) => p.isActive)
        .map((p) => ({ value: p.name, label: p.name }));
      if (options.length > 0) setPresetOptions(options);
      const pdfOptions = (cfg.pdfTemplates ?? [])
        .filter((p: CutPdfTemplate) => p.isActive)
        .map((p) => ({ value: p.code, label: p.name }));
      if (pdfOptions.length > 0) setPdfTemplateOptions(pdfOptions);
      setProfiles(cfg.paramProfiles); // FULL list (active + inactive)
      setCutSettings(cfg.settings);
    } catch {
      // keep the current/built-in options on failure
    }
  }, []);

  const refreshCutConfigOnPdfTemplateOpen = useCallback((open: boolean) => {
    if (open) void loadCutConfig();
  }, [loadCutConfig]);

  useEffect(() => {
    void loadCutConfig();
  }, [loadCutConfig]);

  useEffect(() => subscribeCutPdfTemplatesChanged(() => {
    void loadCutConfig();
  }), [loadCutConfig]);

  // The /cut tab is kept alive (not remounted) when switching tabs, so profiles
  // created elsewhere (e.g. /configuration "Раскрой") would otherwise stay stale.
  // Refetch the config whenever this tab is re-activated.
  const { isActive } = useKeepAlive();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      void loadCutConfig();
    }
    wasActiveRef.current = isActive;
  }, [isActive, loadCutConfig]);

  const criteriaFromForm = useCallback(() => {
    const values = form.getFieldsValue();
    // sheetMaterialTypeIds: comes from a Select<number[]> (not a CSV string) when the
    // sheet filter is enabled; falls back to empty array otherwise.
    const sheetMaterialTypeIds: number[] | undefined =
      values.sheetMaterialTypeIds && values.sheetMaterialTypeIds.length > 0
        ? values.sheetMaterialTypeIds
        : undefined;
    return {
      orderIds: isEmbeddedOrder ? [embeddedOrderId!] : parseOrderIdsValue(values.orderIds),
      sheetMaterialTypeIds,
      filmIds: parseOrderIdsValue(values.filmIds),
      ...(!isEmbeddedOrder ? cutDateRangeToCriteria(values.orderDateRange) : {}),
    };
  }, [embeddedOrderId, form, isEmbeddedOrder]);

  const handleError = useCallback((error: unknown, fallback: string) => {
    const text = error instanceof ApiError ? error.message : fallback;
    message.error(text);
  }, []);

  const filmCriteriaOrderIds = useMemo(
    () => (isEmbeddedOrder ? [embeddedOrderId!] : parseOrderIdsValue(watchedOrderIds)),
    [embeddedOrderId, isEmbeddedOrder, watchedOrderIds],
  );
  const filmCriteriaSheetMaterialTypeIds = useMemo(
    () => {
      const ids = (watchedSheetMaterialTypeIds ?? []).filter((id) => Number.isInteger(id) && id > 0);
      return ids.length > 0 ? ids : undefined;
    },
    [watchedSheetMaterialTypeIds],
  );
  const filmCriteriaOrderIdsKey = filmCriteriaOrderIds?.join(',') ?? '';
  const filmCriteriaSheetMaterialTypeIdsKey = filmCriteriaSheetMaterialTypeIds?.join(',') ?? '';

  useEffect(() => {
    if (isEmbeddedOrder || !canViewOrders || !orderDateFrom || !orderDateTo) {
      setOrderOptions([]);
      return;
    }
    const seq = ++orderOptionsSeqRef.current;
    setOrdersLoading(true);
    fetchCutOrderOptions(orderDateFrom, orderDateTo)
      .then((options) => {
        if (orderOptionsSeqRef.current !== seq) return;
        setOrderOptions(options);
      })
      .catch((error) => {
        if (orderOptionsSeqRef.current !== seq) return;
        handleError(error, 'Не удалось загрузить заказы для раскроя');
      })
      .finally(() => {
        if (orderOptionsSeqRef.current === seq) setOrdersLoading(false);
      });
  }, [canViewOrders, handleError, isEmbeddedOrder, orderDateFrom, orderDateTo]);

  useEffect(() => {
    if (!isEmbeddedOrder && (!orderDateFrom || !orderDateTo)) {
      setFilmOptions([]);
      return;
    }
    const seq = ++filmOptionsSeqRef.current;
    setFilmsLoading(true);
    cutApi.listFilmOptions({
      orderIds: filmCriteriaOrderIds,
      sheetMaterialTypeIds: filmCriteriaSheetMaterialTypeIds,
      ...(!isEmbeddedOrder ? { dateFrom: orderDateFrom, dateTo: orderDateTo } : {}),
    })
      .then((options) => {
        if (filmOptionsSeqRef.current !== seq) return;
        setFilmOptions(options.map(buildCutFilmOption));
      })
      .catch((error) => {
        if (filmOptionsSeqRef.current !== seq) return;
        setFilmOptions([]);
        handleError(error, 'Не удалось загрузить плёнки для раскроя');
      })
      .finally(() => {
        if (filmOptionsSeqRef.current === seq) setFilmsLoading(false);
      });
  }, [
    filmCriteriaOrderIds,
    filmCriteriaOrderIdsKey,
    filmCriteriaSheetMaterialTypeIds,
    filmCriteriaSheetMaterialTypeIdsKey,
    handleError,
    isEmbeddedOrder,
    orderDateFrom,
    orderDateTo,
  ]);

  const buildOperationalListFilters = useCallback(
    (orderSearch: string, dateRange: CutOrderDateRangeValue): CutJobListFilters => ({
      ...(orderSearch.trim() ? { orderSearch: orderSearch.trim() } : {}),
      ...(dateRange?.[0] ? { createdFrom: dateRange[0].format('YYYY-MM-DD') } : {}),
      ...(dateRange?.[1] ? { createdTo: dateRange[1].format('YYYY-MM-DD') } : {}),
    }),
    [],
  );

  const loadJobs = useCallback(async (filtersOverride?: CutJobListFilters) => {
    setJobsLoading(true);
    try {
      const filters = filtersOverride ?? (isEmbeddedOrder ? {} : listFiltersRef.current);
      const [nextJobs, placements] = await Promise.all([
        cutApi.list(filters),
        isEmbeddedOrder ? cutApi.listPlacements({ orderIds: [embeddedOrderId!] }) : Promise.resolve(null),
      ]);
      setJobs(nextJobs);
      setEmbeddedJobIds(placements ? new Set(placements.jobs.map((ref) => ref.cutJobId)) : null);
    } catch (error) {
      handleError(error, 'Не удалось загрузить список раскроев');
    } finally {
      setJobsLoading(false);
    }
  }, [
    embeddedOrderId,
    handleError,
    isEmbeddedOrder,
  ]);

  useEffect(() => {
    if (!isEmbeddedOrder) return;
    form.setFieldsValue({ orderIds: String(embeddedOrderId) });
  }, [embeddedOrderId, form, isEmbeddedOrder]);

  const cutTabPath = useTabStore((s) => s.tabs.find((t) => t.key === '/cut')?.path);
  const lastListRefreshPathRef = useRef<string | undefined>(undefined);

  // /cut is kept mounted by the workspace. Jobs may be created from an order
  // while this page is hidden, so refresh the list when the /cut tab is opened
  // or its path changes via useTabSync/deep-link.
  useEffect(() => {
    if (!can('cut.view')) return;
    if (!cutTabPath) return;
    if (cutTabPath === lastListRefreshPathRef.current) return;
    lastListRefreshPathRef.current = cutTabPath;
    void loadJobs();
  }, [cutTabPath, loadJobs]);

  const setJobProfile = useCallback(
    async (paramProfileId: number | null) => {
      if (!job) return;
      setBusy(true);
      try {
        const { bathSheetMissing } = await applyCutProfileSelection({
          currentJob: job,
          paramProfileId,
          profiles,
          sheetOptions,
          mutations: {
            setProfile: cutApi.setProfile,
            setSplitByMaterial: cutApi.setSplitByMaterial,
            setCombineFilms: cutApi.setCombineFilms,
            setSheetMaterial: cutApi.setSheetMaterial,
          },
          onUpdated: (updated) => {
            setJob(updated);
            applyPdfTemplateState(updated);
          },
        });
        if (bathSheetMissing) {
          message.warning('Не найден материал листа, название которого начинается с «Ванна»');
        }
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось применить профиль раскроя');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, loadJobs, handleError, profiles, sheetOptions],
  );

  const setJobSheetMaterial = useCallback(
    async (sheetMaterialTypeId: number | null) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setSheetMaterial(job.cutJobId, sheetMaterialTypeId, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить лист раскроя');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobCombineFilms = useCallback(
    async (combineFilms: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setCombineFilms(job.cutJobId, combineFilms, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить объединение плёнок');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobRotationAllowed = useCallback(
    async (rotationAllowed: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setRotationAllowed(job.cutJobId, rotationAllowed, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить разрешение поворота');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobTextureDirection = useCallback(
    async (textureDirection: CutTextureDirection) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setTextureDirection(job.cutJobId, textureDirection, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось сохранить направление текстуры');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobSplitByMaterial = useCallback(
    async (splitByMaterial: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setSplitByMaterial(job.cutJobId, splitByMaterial, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить разделение по материалу');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobPdfTemplate = useCallback(
    async (pdfTemplate: string) => {
      if (!job) return;
      const previous = pdfTemplateForJob;
      setPdfTemplateForJob(pdfTemplate);
      if (pdfTemplateIsRequestOnly) return;
      try {
        const updated = await cutApi.setJobPdfTemplate(job.cutJobId, pdfTemplate);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        setPdfTemplateForJob(previous);
        handleError(error, 'Не удалось сохранить шаблон PDF раскроя');
      }
    },
    [applyPdfTemplateState, job, pdfTemplateForJob, pdfTemplateIsRequestOnly, handleError, loadJobs],
  );

  const setGroupPdfTemplate = useCallback(
    async (group: CutGroupDto, pdfTemplate: string) => {
      if (!job) return;
      const previous = pdfTemplateByGroup[group.cutGroupId] ?? group.pdfTemplate ?? 'standard';
      setPdfTemplateByGroup((prev) => ({ ...prev, [group.cutGroupId]: pdfTemplate }));
      if (pdfTemplateIsRequestOnly) return;
      try {
        const updated = await cutApi.setGroupPdfTemplate(job.cutJobId, group.cutGroupId, pdfTemplate);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        setPdfTemplateByGroup((prev) => ({ ...prev, [group.cutGroupId]: previous }));
        handleError(error, 'Не удалось сохранить шаблон PDF группы');
      }
    },
    [applyPdfTemplateState, job, pdfTemplateByGroup, pdfTemplateIsRequestOnly, handleError, loadJobs],
  );

  const startJobNameEdit = useCallback(() => {
    if (!job) return;
    setJobNameDraft(job.name);
    setIsEditingJobName(true);
  }, [job]);

  const cancelJobNameEdit = useCallback(() => {
    setJobNameDraft(job?.name ?? '');
    setIsEditingJobName(false);
  }, [job?.name]);

  const saveJobName = useCallback(async () => {
    if (!job) return;
    const name = jobNameDraft.trim();
    if (!name) {
      message.warning('Введите название задания на раскрой');
      return;
    }
    if (name === job.name) {
      setJobNameDraft(job.name);
      setIsEditingJobName(false);
      return;
    }
    setBusy(true);
    setJobNameSaving(true);
    try {
      const updated = await cutApi.setName(job.cutJobId, name, job.version);
      setJob(updated);
      setJobNameDraft(updated.name);
      setIsEditingJobName(false);
      applyPdfTemplateState(updated);
      void loadJobs();
      message.success('Название задания сохранено');
    } catch (error) {
      handleError(error, 'Не удалось сохранить название задания');
    } finally {
      setJobNameSaving(false);
      setBusy(false);
    }
  }, [applyPdfTemplateState, handleError, job, jobNameDraft, loadJobs]);

  // Load the existing (non-archived) jobs on mount so an operator can reopen a
  // job created earlier — including jobs staged from the Orders "Добавить в
  // раскрой" action, which previously had no surface to be reopened on.
  useEffect(() => {
    if (canViewCut) void loadJobs();
  }, [canViewCut, loadJobs]);

  // Last-write-wins guard for openJob: a stale in-flight cutApi.get (e.g. rapid
  // deep-link /cut?job=45 -> 46, or fast successive row opens) must not overwrite
  // the UI with an older job after a newer open started. Each call captures its
  // sequence; only the latest applies its result/error/busy reset.
  const openSeqRef = useRef(0);
  const openJob = useCallback(
    async (cutJobId: number, resultNo?: number) => {
      const seq = ++openSeqRef.current;
      setBusy(true);
      try {
        const fresh = await cutApi.get(cutJobId);
        if (openSeqRef.current !== seq) return; // superseded by a newer openJob
        let openedJob = fresh;
        let openedResult: CutResultSummary | null = fresh.currentCutResult ?? null;
        if (resultNo !== undefined) {
          const frozen = await cutApi.getResult(cutJobId, resultNo);
          if (openSeqRef.current !== seq) return;
          openedJob = {
            ...frozen.job,
            cutResults: fresh.cutResults,
            currentCutResult: fresh.currentCutResult,
          };
          openedResult = frozen;
        }
        setJob(openedJob);
        setSelectedResult(openedResult);
        setIsFrozenResultSelection(resultNo !== undefined);
        applyPdfTemplateState(openedJob);
        // Initialise per-group alternative-view toggle from persisted isActive so
        // the checkbox position matches the last saved manual-layout state.
        const initAlt: Record<number, boolean> = {};
        for (const g of openedJob.groups) {
          initAlt[g.cutGroupId] = g.manualLayout?.isActive ?? false;
        }
        setShowAlternativeByGroup(initAlt);
        // Reset any open editor (a reopened job starts without an active edit).
        setEditingGroupId(null);
        setWorkingSheets([]);
        setViolations([]);
        setEditorHistory([]);
        // Prefill the visible criteria from the opened job itself: operators see
        // order numbers, films, and sheet materials already reserved into this job.
        const openedOrderOptions = cutJobOrderOptions(openedJob);
        const openedFilmIds = optionValues(cutJobFilmOptions(openedJob));
        const openedSheetMaterialTypeIds = optionValues(cutJobSheetTypeOptions(openedJob));
        const orderIds = isEmbeddedOrder ? [embeddedOrderId!] : optionValues(openedOrderOptions);
        form.setFieldsValue({
          name: openedJob.name,
          orderDateRange: undefined,
          orderIds: orderIds.length > 0 ? (canViewOrders ? orderIds : orderIds.join(',')) : undefined,
          sheetMaterialTypeIds: openedSheetMaterialTypeIds.length > 0 ? openedSheetMaterialTypeIds : undefined,
          filmIds: openedFilmIds.length > 0 ? openedFilmIds : undefined,
        });
        setEligible(null);
        setSelected([]);
        resetSheetViews();
        void loadJobs();
      } catch (error) {
        if (openSeqRef.current !== seq) return; // superseded; swallow the stale error
        handleError(error, 'Не удалось открыть раскрой');
      } finally {
        if (openSeqRef.current === seq) setBusy(false);
      }
    },
    [canViewOrders, embeddedOrderId, form, handleError, isEmbeddedOrder, loadJobs, resetSheetViews],
  );

  const openResult = useCallback(
    async (result: CutResultSummary) => {
      if (!job) return;
      if (!isEmbeddedOrder) {
        const path = `/cut?job=${job.cutJobId}&result=${result.resultNo}`;
        window.history.pushState(null, '', path);
        useTabStore.getState().openTab({ key: '/cut', path, label: 'Раскрой', resource: 'cut' });
        return;
      }
      await openJob(job.cutJobId, result.resultNo);
    },
    [isEmbeddedOrder, job, openJob],
  );

  const returnToCurrentResult = useCallback(() => {
    if (!job) return;
    if (isEmbeddedOrder) {
      void openJob(job.cutJobId);
      return;
    }
    const path = `/cut?job=${job.cutJobId}`;
    window.history.pushState(null, '', path);
    useTabStore.getState().openTab({ key: '/cut', path, label: 'Раскрой', resource: 'cut' });
  }, [isEmbeddedOrder, job, openJob]);

  const refreshAfterResultStateChange = useCallback(
    async (resultNoToKeep?: number) => {
      if (!job) return;
      await openJob(job.cutJobId, resultNoToKeep);
      await loadJobs();
    },
    [job, loadJobs, openJob],
  );

  const emitCutJobUpdate = useCallback(
    (
      updated: Pick<CutJobDto, 'cutJobId' | 'name' | 'items'>,
      previous?: Pick<CutJobDto, 'items'> | null,
    ) => {
      emitCutJobReady(updated, {
        detailIds: previous?.items.map((item) => item.orderDetailId),
        orderIds: previous?.items.map((item) => item.orderId),
      });
    },
    [],
  );

  const setCurrentResult = useCallback(
    async (result: CutResultSummary) => {
      if (!job || result.isCurrent || result.isArchived) return;
      setBusy(true);
      try {
        const updated = await cutApi.setCurrentResult(job.cutJobId, result.resultNo);
        emitCutJobUpdate(updated, job);
        message.success(`Раскрой ${result.cutNumber} назначен действующим`);
        await refreshAfterResultStateChange();
      } catch (error) {
        handleError(error, 'Не удалось назначить действующий раскрой');
      } finally {
        setBusy(false);
      }
    },
    [emitCutJobUpdate, handleError, job, refreshAfterResultStateChange],
  );

  const archiveResult = useCallback(
    async (result: CutResultSummary) => {
      if (!job || result.isCurrent || result.isArchived) return;
      setBusy(true);
      try {
        const updated = await cutApi.archiveResult(job.cutJobId, result.resultNo);
        emitCutJobUpdate(updated, job);
        message.success(`Раскрой ${result.cutNumber} отправлен в архив`);
        await refreshAfterResultStateChange(selectedResult?.resultNo === result.resultNo ? result.resultNo : undefined);
      } catch (error) {
        handleError(error, 'Не удалось архивировать раскрой');
      } finally {
        setBusy(false);
      }
    },
    [emitCutJobUpdate, handleError, job, refreshAfterResultStateChange, selectedResult?.resultNo],
  );

  const unarchiveResult = useCallback(
    async (result: CutResultSummary) => {
      if (!job || !result.isArchived) return;
      setBusy(true);
      try {
        const updated = await cutApi.unarchiveResult(job.cutJobId, result.resultNo);
        emitCutJobUpdate(updated, job);
        message.success(`Раскрой ${result.cutNumber} возвращён из архива`);
        await refreshAfterResultStateChange(selectedResult?.resultNo === result.resultNo ? result.resultNo : undefined);
      } catch (error) {
        handleError(error, 'Не удалось вернуть раскрой из архива');
      } finally {
        setBusy(false);
      }
    },
    [emitCutJobUpdate, handleError, job, refreshAfterResultStateChange, selectedResult?.resultNo],
  );

  const cutResultColumns: ColumnsType<CutResultSummary> = useMemo(
    () => [
      { title: 'Номер', dataIndex: 'cutNumber', key: 'cutNumber', width: 110 },
      {
        title: 'Тип',
        dataIndex: 'resultKind',
        key: 'resultKind',
        width: 110,
        render: (kind: CutResultSummary['resultKind']) => kind === 'auto' ? 'Авто' : kind === 'manual' ? 'Ручной' : 'Существующий',
      },
      {
        title: 'Создан',
        dataIndex: 'createdAt',
        key: 'createdAt',
        render: (value: string) => new Date(value).toLocaleString('ru-RU'),
      },
      { title: 'Автор', dataIndex: 'createdByName', key: 'createdByName', render: (value: string | null) => value || '—' },
      { title: 'Листы', key: 'sheets', width: 80, render: (_: unknown, row: CutResultSummary) => row.totals.sheets },
      {
        title: 'Статус',
        key: 'current',
        width: 150,
        render: (_: unknown, row: CutResultSummary) => (
          <Space size={4} wrap>
            {row.isCurrent && <Tag color="green">Действующий</Tag>}
            {row.isArchived && <Tag>Архив</Tag>}
          </Space>
        ),
      },
      {
        title: 'Действие',
        key: 'action',
        width: 260,
        render: (_: unknown, row: CutResultSummary) => (
          <Space size={4} wrap>
            <Button size="small" type="link" disabled={busy || (isFrozenResultSelection && selectedResult?.cutResultId === row.cutResultId)} onClick={() => void openResult(row)}>
              Открыть
            </Button>
            {!row.isCurrent && !row.isArchived && (
              <Button size="small" type="link" disabled={busy} onClick={() => void setCurrentResult(row)}>
                Сделать действующим
              </Button>
            )}
            {row.isArchived ? (
              <Button size="small" type="link" disabled={busy} onClick={() => void unarchiveResult(row)}>
                Вернуть
              </Button>
            ) : (
              <Button size="small" type="link" danger disabled={busy || row.isCurrent} onClick={() => void archiveResult(row)}>
                В архив
              </Button>
            )}
          </Space>
        ),
      },
    ],
    [archiveResult, busy, isFrozenResultSelection, openResult, selectedResult?.cutResultId, setCurrentResult, unarchiveResult],
  );

  // Deep-link: /cut?job=<id> opens that job (e.g. from the order show page
  // «Раскрой» column). The workspace keeps /cut mounted (keyed by pathname), so
  // subscribe to the /cut tab's stored path (updated by useTabSync on every query
  // change) rather than reading window.location once — otherwise a deep-link
  // clicked while /cut is already open would not reopen. Per-job-id one-shot:
  // opens when the parsed id changes to a new value. openJob loads ANY existing
  // job by id (getJob/loadJob do not filter archived) and shows it; a missing/
  // invalid id throws and is caught by openJob's handleError toast. The column
  // only links ready jobs, so the normal flow never deep-links archived — only a
  // stale/hand-edited URL can, and mutate controls are disabled for archived jobs
  // (isArchivedJob guard) so that is truly read-only.
  const storeDeepLinkJobId = parseJobQueryParam(
    cutTabPath && cutTabPath.includes('?') ? cutTabPath.slice(cutTabPath.indexOf('?')) : '',
  );
  const storeDeepLinkResultNo = parseResultQueryParam(
    cutTabPath && cutTabPath.includes('?') ? cutTabPath.slice(cutTabPath.indexOf('?')) : '',
  );
  // Cross-check against the LIVE url: the tab store rehydrates from sessionStorage
  // and is only rewritten by useTabSync after mount, so on a fresh /cut?job=45
  // load the store may briefly hold a stale persisted /cut path. Acting on it would
  // openJob(staleId) and then race openJob(45). Only honor the deep-link once the
  // store path's id agrees with the live url, so the stale value is skipped until
  // useTabSync catches up. window.location is a plain DOM read, not a router hook.
  const liveDeepLinkJobId = parseJobQueryParam(
    typeof window !== 'undefined' ? window.location.search : '',
  );
  const liveDeepLinkResultNo = parseResultQueryParam(
    typeof window !== 'undefined' ? window.location.search : '',
  );
  const deepLinkJobId =
    storeDeepLinkJobId !== null && storeDeepLinkJobId === liveDeepLinkJobId ? storeDeepLinkJobId : null;
  const deepLinkResultNo = storeDeepLinkResultNo === liveDeepLinkResultNo ? storeDeepLinkResultNo : null;
  const lastDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (!can('cut.view')) return;
    if (deepLinkJobId === null) return;
    const key = `${deepLinkJobId}:${deepLinkResultNo ?? 'current'}`;
    if (lastDeepLinkRef.current === key) return;
    lastDeepLinkRef.current = key;
    void openJob(deepLinkJobId, deepLinkResultNo ?? undefined);
  }, [deepLinkJobId, deepLinkResultNo, openJob]);

  const archiveJob = useCallback(
    async (target: CutJobDto) => {
      setBusy(true);
      try {
        const fresh = await cutApi.get(target.cutJobId);
        const archived = await cutApi.archive(fresh.cutJobId, fresh.version);
        emitCutJobUpdate(archived, fresh);
        message.success('Раскрой архивирован');
        if (job?.cutJobId === target.cutJobId) {
          setJob(null);
          setEligible(null);
          setSelected([]);
          resetSheetViews();
        }
        await loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось архивировать раскрой');
      } finally {
        setBusy(false);
      }
    },
    [emitCutJobUpdate, job, loadJobs, handleError, resetSheetViews],
  );

  const previewCreateJob = useCallback(async () => {
    setBusy(true);
    try {
      const response = await cutApi.listEligibleDetailsPreview(criteriaFromForm());
      const selectable = selectableDetailIds(response.details);
      setPreviewName(buildSuggestedCutName(response.details));
      setJob(null);
      setSelectedResult(null);
      setIsFrozenResultSelection(false);
      applyPdfTemplateState(null);
      setEligible(response.details);
      setNoSheetSpecCount(response.noSheetSpecCount);
      setSelected(selectable);
      resetSheetViews();
      if (response.details.length === 0) {
        message.warning('По выбранным критериям деталей не найдено');
      }
    } catch (error) {
      handleError(error, 'Не удалось загрузить детали для проверки');
    } finally {
      setBusy(false);
    }
  }, [applyPdfTemplateState, criteriaFromForm, handleError, resetSheetViews]);

  const createJobFromPreview = useCallback(async () => {
    if (selected.length === 0) {
      message.warning('Выберите детали для раскроя');
      return;
    }
    const name = previewName.trim();
    if (!name) {
      message.warning('Укажите название раскроя');
      return;
    }
    setBusy(true);
    try {
      const created = await cutApi.create({ name, detailIds: selected });
      setJob(created);
      applyPdfTemplateState(created);
      const createdOrderOptions = cutJobOrderOptions(created);
      const createdOrderIds = isEmbeddedOrder ? [embeddedOrderId!] : optionValues(createdOrderOptions);
      const createdFilmIds = optionValues(cutJobFilmOptions(created));
      const createdSheetMaterialTypeIds = optionValues(cutJobSheetTypeOptions(created));
      form.setFieldsValue({
        name: created.name,
        orderDateRange: undefined,
        orderIds: createdOrderIds.length > 0 ? (canViewOrders ? createdOrderIds : createdOrderIds.join(',')) : undefined,
        sheetMaterialTypeIds: createdSheetMaterialTypeIds.length > 0 ? createdSheetMaterialTypeIds : undefined,
        filmIds: createdFilmIds.length > 0 ? createdFilmIds : undefined,
      });
      setEligible(null);
      setSelected([]);
      setPreviewName('');
      resetSheetViews(); // new job context: drop any previewed prior job's blobs
      message.success('Раскрой создан');
      await loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось создать раскрой');
    } finally {
      setBusy(false);
    }
  }, [applyPdfTemplateState, canViewOrders, embeddedOrderId, form, handleError, isEmbeddedOrder, loadJobs, previewName, resetSheetViews, selected]);

  const loadEligible = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const response = await cutApi.listEligibleDetails(job.cutJobId, criteriaFromForm());
      setEligible(response.details);
      setNoSheetSpecCount(response.noSheetSpecCount);
      setSelected(selectableDetailIds(response.details));
    } catch (error) {
      handleError(error, 'Не удалось загрузить детали');
    } finally {
      setBusy(false);
    }
  }, [job, criteriaFromForm, handleError]);

  const closeEligibleDetails = useCallback(() => {
    setEligible(null);
    setNoSheetSpecCount(0);
    setSelected([]);
  }, []);

  const addToBasket = useCallback(async () => {
    if (!job || selected.length === 0) return;
    setBusy(true);
    try {
      const updated = await cutApi.addItems(job.cutJobId, { detailIds: selected, version: job.version });
      setJob(updated);
      applyPdfTemplateState(updated);
      emitCutJobUpdate(updated, job);
      message.success('Детали добавлены в раскрой');
      setEligible(null);
      setNoSheetSpecCount(0);
      setSelected([]);
      await loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось добавить детали');
    } finally {
      setBusy(false);
    }
  }, [applyPdfTemplateState, emitCutJobUpdate, job, selected, loadJobs, handleError]);

  const removeJobItem = useCallback(
    async (cutJobItemId: number) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.removeItem(job.cutJobId, cutJobItemId, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        emitCutJobUpdate(updated, job);
        message.success('Деталь убрана из раскроя');
        await loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось убрать деталь');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, emitCutJobUpdate, job, loadJobs, handleError],
  );

  const calculate = useCallback(async () => {
    if (!job) return;
    if (calcCommandRef.current?.cutJobId !== job.cutJobId) {
      calcCommandRef.current = {
        cutJobId: job.cutJobId,
        version: job.version,
        commandId: crypto.randomUUID(),
      };
    }
    const { commandId, version: commandVersion } = calcCommandRef.current;
    setBusy(true);
    try {
      const calculated = await cutApi.calculate(job.cutJobId, commandVersion, commandId);
      calcCommandRef.current = null;
      setJob(calculated);
      setSelectedResult(calculated.currentCutResult ?? null);
      setIsFrozenResultSelection(false);
      applyPdfTemplateState(calculated);
      resetSheetViews();
      emitCutJobReady(calculated);
      message.success('Раскрой рассчитан');
      await loadJobs();
    } catch (error) {
      // Reload so the now-failed job shows its persisted reason (Alert) and a
      // fresh version for an immediate retry — the failure bumped the version
      // server-side, so the stale in-memory job would otherwise 409 on retry.
      try {
        const fresh = await cutApi.get(job.cutJobId);
        const responseWasLostAfterSuccess =
          fresh.status === 'ready'
          && fresh.currentCutResult !== null
          && fresh.currentCutResult !== undefined
          && fresh.currentCutResult.cutResultId !== job.currentCutResult?.cutResultId;
        const commandCannotBeRetried = error instanceof ApiError && [
          'CUT_STALE_VERSION',
          'CUT_RESULT_COMMAND_CONFLICT',
          'CUT_RESULT_COMMAND_FAILED',
          'CUT_RESULT_COMMAND_ABANDONED',
          'CUT_JOB_NOT_MUTABLE',
        ].includes(error.code);
        if (
          responseWasLostAfterSuccess
          || fresh.status === 'failed'
          || commandCannotBeRetried
        ) {
          calcCommandRef.current = null;
        }
        setJob(fresh);
        setSelectedResult(fresh.currentCutResult ?? null);
        setIsFrozenResultSelection(false);
        applyPdfTemplateState(fresh);
        await loadJobs();
        if (responseWasLostAfterSuccess) {
          emitCutJobReady(fresh);
          message.success('Раскрой рассчитан');
          return;
        }
      } catch {
        // best-effort refresh; retain commandId so a transport retry dedupes
      }
      handleError(error, 'Не удалось рассчитать раскрой');
    } finally {
      setBusy(false);
    }
  }, [applyPdfTemplateState, job, loadJobs, handleError, resetSheetViews]);

  const loadSheet = useCallback(
    async (group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      if (!job) return;
      // Client cache key = group:sheet:variant:orientation:origin. NO renderVersion —
      // a version bump that does not recompute the layout (profile/material change)
      // re-uses the cached blob instead of re-fetching/flickering. Orientation AND
      // origin are in the key because each changes the rendered image and a job
      // switch can rehydrate a different saved orientation/origin (so it must
      // re-fetch, not dedupe to a stale-pref blob — Codex code-review R1
      // [REGRESSION-DEBT] for origin). Layout changes still bust via
      // resetSheetViews() (clears maps + thumbReqRef + epoch); renderVersion stays
      // in the FETCH to bust the SERVER render cache.
      const key = `${group.cutGroupId}:${sheetIndex}:${variant}:${sheetPortrait ? 'P' : 'L'}:${sheetOriginTopLeft ? 'tl' : 'raw'}:${sheetAxisOrigin}`;
      const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
      const rotate90 = sheet
        ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
        : sheetPortrait;
      const originTopLeft = effectiveSheetOrigin(sheet?.placements, sheetOriginTopLeft, sheetAxisOrigin);
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(job.cutJobId, group.cutGroupId, sheetIndex, preset, rotate90, variant, renderVersion, originTopLeft, sheetAxisOrigin, isHistoricalResult ? selectedResult?.resultNo : undefined);
        // Discard a completion that lands after a job switch/reset (stale blob).
        if (viewEpochRef.current !== epoch) return;
        setSheetImages((prev) => {
          if (prev[key]) URL.revokeObjectURL(prev[key]);
          return { ...prev, [key]: URL.createObjectURL(blob) };
        });
      } catch (error) {
        handleError(error, 'Не удалось загрузить лист раскроя');
      }
    },
    [handleError, isHistoricalResult, job, preset, selectedResult?.resultNo, sheetAxisOrigin, sheetOriginTopLeft, sheetPortrait],
  );

  // Small layout preview for a ready job's sheet, fetched once with the light
  // 'thumb' preset. Deduped via thumbReqRef so the auto-load effect is idempotent.
  // Client cache key = group:sheet:variant:orientation (NO renderVersion). Orientation
  // is in the key so a job-switch that rehydrates a different saved orientation re-fetches
  // instead of deduping to a stale-orientation thumb. resetSheetViews() (calculate / save /
  // orientation toggle / job switch) clears the maps + thumbReqRef + epoch on layout change.
  // renderVersion is still passed to the FETCH (server render-cache bust); out of the client
  // key so a no-recalc version bump (profile/material change) does not re-fetch/flicker.
  const loadThumb = useCallback(
    async (cutJobId: number, group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      // origin in the key too (same rehydration reason as orientation — a persisted
      // RAW-origin job opening with the stale default-TL state must re-fetch, not
      // dedupe to a TL thumb; Codex code-review R1 [REGRESSION-DEBT]).
      const key = `${group.cutGroupId}:${sheetIndex}:${variant}:${sheetPortrait ? 'P' : 'L'}:${sheetOriginTopLeft ? 'tl' : 'raw'}:${sheetAxisOrigin}`;
      const reqKey = `${cutJobId}:${key}`;
      if (thumbReqRef.current.has(reqKey)) return;
      thumbReqRef.current.add(reqKey);
      const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
      const rotate90 = sheet
        ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
        : sheetPortrait;
      const originTopLeft = effectiveSheetOrigin(sheet?.placements, sheetOriginTopLeft, sheetAxisOrigin);
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(cutJobId, group.cutGroupId, sheetIndex, 'thumb', rotate90, variant, renderVersion, originTopLeft, sheetAxisOrigin, isHistoricalResult ? selectedResult?.resultNo : undefined);
        // Discard a completion that lands after a job switch/reset (stale blob).
        if (viewEpochRef.current !== epoch) return;
        setSheetThumbs((prev) => {
          if (prev[key]) URL.revokeObjectURL(prev[key]);
          return { ...prev, [key]: URL.createObjectURL(blob) };
        });
      } catch {
        // Preview is best-effort; the full-size "Лист N" view still works on click.
        thumbReqRef.current.delete(reqKey);
      }
    },
    [isHistoricalResult, selectedResult?.resultNo, sheetAxisOrigin, sheetOriginTopLeft, sheetPortrait],
  );

  // Auto-load per-sheet previews when a ready job's layout is present, so an
  // operator sees the cut result inline without clicking each sheet.
  // Passes the current per-group variant so toggling auto↔manual immediately
  // requests the correct thumb (variant changes cause the effect to re-run).
  useEffect(() => {
    if (!job || job.status !== 'ready') return;
    for (const group of job.groups) {
      const showAlt = showAlternativeByGroup[group.cutGroupId] ?? false;
      const groupVariant: 'auto' | 'manual' | 'active' = showAlt ? 'manual' : 'auto';
      const groupRenderVersion = group.renderToken;
      for (const sheet of group.sheets) {
        void loadThumb(job.cutJobId, group, sheet.sheetIndex, groupVariant, groupRenderVersion);
      }
    }
  }, [job, showAlternativeByGroup, loadThumb]);

  const downloadSheetSvg = useCallback(
    async (group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string, displayNo?: number) => {
      if (!job) return;
      try {
        const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
        const rotate90 = sheet
          ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
          : sheetPortrait;
        const originTopLeft = effectiveSheetOrigin(sheet?.placements, sheetOriginTopLeft, sheetAxisOrigin);
        const blob = await cutApi.fetchSheetSvg(job.cutJobId, group.cutGroupId, sheetIndex, rotate90, variant, renderVersion, originTopLeft, sheetAxisOrigin, isHistoricalResult ? selectedResult?.resultNo : undefined);
        // Filename uses the displayed sheet number (dense 1..N) so it matches the
        // "Лист N" the operator sees, not the possibly-sparse real sheetIndex.
        const fileNo = displayNo ?? sheetIndex + 1;
        triggerBlobDownload(blob, `cut-${job.cutJobId}-g${group.cutGroupId}-s${fileNo}.svg`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить SVG');
      }
    },
    [handleError, isHistoricalResult, job, selectedResult?.resultNo, sheetAxisOrigin, sheetOriginTopLeft, sheetPortrait],
  );

  const openGroupPdfPreview = useCallback(
    async (group: CutGroupDto) => {
      if (!job) return;
      const requestSeq = pdfPreviewRequestSeqRef.current + 1;
      pdfPreviewRequestSeqRef.current = requestSeq;
      setBusy(true);
      revokePdfPreviewUrl();
      setPdfPreview({ ...EMPTY_PDF_PREVIEW, open: true, group, title: `Предпросмотр PDF · группа #${group.cutGroupId}`, loading: true });
      try {
        // Pass renderToken so the backend uses the active layout variant; PDF bytes are rendered fresh.
        const pdfTemplate = pdfTemplateByGroup[group.cutGroupId] ?? 'standard';
        const result = await pollPdf(() => cutApi.fetchGroupPdf(job.cutJobId, group.cutGroupId, sheetPortrait, group.renderToken, sheetAxisOrigin === 'bottom-left' ? false : sheetOriginTopLeft, pdfTemplate, sheetAxisOrigin, isHistoricalResult ? selectedResult?.resultNo : undefined));
        if (pdfPreviewRequestSeqRef.current !== requestSeq) return;
        const url = URL.createObjectURL(result.blob);
        pdfPreviewUrlRef.current = url;
        setPdfPreview({
          open: true,
          group,
          title: `Предпросмотр PDF · группа #${group.cutGroupId}`,
          loading: false,
          url,
          blob: result.blob,
          fileName: result.fileName ?? `cut-group-${group.cutGroupId}.pdf`,
        });
      } catch (error) {
        if (pdfPreviewRequestSeqRef.current === requestSeq) {
          setPdfPreview((prev) => ({ ...prev, loading: false }));
        }
        handleError(error, 'Не удалось выгрузить PDF группы');
      } finally {
        setBusy(false);
      }
    },
    [handleError, isHistoricalResult, job, pdfTemplateByGroup, revokePdfPreviewUrl, selectedResult?.resultNo, sheetAxisOrigin, sheetOriginTopLeft, sheetPortrait],
  );

  const closeGroupPdfPreview = useCallback(() => {
    pdfPreviewRequestSeqRef.current += 1;
    revokePdfPreviewUrl();
    setPdfPreview(EMPTY_PDF_PREVIEW);
  }, [revokePdfPreviewUrl]);

  const downloadPreviewPdf = useCallback(() => {
    if (!pdfPreview.blob || !pdfPreview.fileName) return;
    triggerBlobDownload(pdfPreview.blob, pdfPreview.fileName);
  }, [pdfPreview.blob, pdfPreview.fileName]);

  const printPreviewPdf = useCallback(() => {
    if (!pdfPreview.blob) {
      message.warning('PDF ещё не готов для печати');
      return;
    }
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      message.warning('Браузер заблокировал окно PDF. Разрешите всплывающие окна.');
      return;
    }
    printWindow.opener = null;
    const printUrl = URL.createObjectURL(pdfPreview.blob);
    printWindow.location.href = printUrl;
    printWindow.focus();
    window.setTimeout(() => URL.revokeObjectURL(printUrl), 60_000);
  }, [pdfPreview.blob]);

  const openJobPdfPreview = useCallback(async () => {
    if (!job) return;
    const requestSeq = pdfPreviewRequestSeqRef.current + 1;
    pdfPreviewRequestSeqRef.current = requestSeq;
    setBusy(true);
    revokePdfPreviewUrl();
    setPdfPreview({
      ...EMPTY_PDF_PREVIEW,
      open: true,
      title: `Предпросмотр PDF · раскрой ${formatCutJobDisplayNumber(job, profiles)}`,
      loading: true,
      fileName: `cut-job-${job.cutJobId}.pdf`,
    });
    try {
      // Pass renderToken so the backend uses the active layout variant; PDF bytes are rendered fresh.
      const result = await pollPdf(() => cutApi.fetchJobPdf(job.cutJobId, sheetPortrait, job.renderToken, sheetAxisOrigin === 'bottom-left' ? false : sheetOriginTopLeft, pdfTemplateForJob, sheetAxisOrigin, isHistoricalResult ? selectedResult?.resultNo : undefined));
      if (pdfPreviewRequestSeqRef.current !== requestSeq) return;
      const url = URL.createObjectURL(result.blob);
      pdfPreviewUrlRef.current = url;
      setPdfPreview({
        open: true,
        group: null,
        title: `Предпросмотр PDF · раскрой ${formatCutJobDisplayNumber(job, profiles)}`,
        loading: false,
        url,
        blob: result.blob,
        fileName: result.fileName ?? `cut-job-${job.cutJobId}.pdf`,
      });
    } catch (error) {
      if (pdfPreviewRequestSeqRef.current === requestSeq) {
        setPdfPreview((prev) => ({ ...prev, loading: false }));
      }
      handleError(error, 'Не удалось выгрузить PDF раскроя');
    } finally {
      setBusy(false);
    }
  }, [handleError, isHistoricalResult, job, pdfTemplateForJob, profiles, revokePdfPreviewUrl, selectedResult?.resultNo, sheetAxisOrigin, sheetOriginTopLeft, sheetPortrait]);

  // ── Manual layout editor callbacks ─────────────────────────────────────────

  /**
   * Enter edit mode for a group: seed workingSheets from the non-stale manual
   * layout when one exists (isActive does NOT gate editability — a saved but
   * currently-hidden manual stays editable, Codex R17 BLOCKER #2). Falls back
   * to the auto sheets when manualLayout is absent or stale.
   */
  const enterEditMode = useCallback(
    (group: CutGroupDto) => {
      if (!job) return;
      const seed = editableSheetsForGroup(group);
      if (validateSheetGroupInvariant(seed)) {
        message.error('Повреждённая раскладка: несовместимые листы в группе');
        return;
      }
      setWorkingSheets(seed);
      setViolations([]);
      setEditorHistory([]);
      // Open zoomed out: the operator first orients across the whole group,
      // then zooms into the sheet they are editing.
      setEditorViewZoom(MIN_EDITOR_VIEW_ZOOM);
      setEditorSheetRotations(Object.fromEntries(seed.map((sheet) => [
        sheet.sheetIndex,
        group.manualLayout?.sheets.find((saved) => saved.sheetIndex === sheet.sheetIndex)?.viewTransform?.rotationDeg ?? 0,
      ])));
      setEditorSheetMirrors(Object.fromEntries(seed.map((sheet) => {
        const saved = group.manualLayout?.sheets.find((candidate) => candidate.sheetIndex === sheet.sheetIndex)?.viewTransform;
        return [sheet.sheetIndex, {
          horizontal: saved?.mirrorHorizontal ?? false,
          vertical: saved?.mirrorVertical ?? false,
        }];
      })));
      setEditingGroupId(group.cutGroupId);
    },
    [job],
  );

  /**
   * Called by SheetEditor on every geometry change. Re-validates all sheets
   * and stores both the new working sheets and the fresh violation list.
   * Trim authority: uses placements.trim_mm (not editorParams), per brief §3.
   */
  const applyEditorSheets = useCallback(
    (effective: { sheetIndex: number; placements: SheetPlacements }[]) => {
      setWorkingSheets(effective);
      if (!job?.editorParams) {
        setViolations([]);
        return;
      }
      const gap = { kerfMm: job.editorParams.kerfMm, spacingMm: job.editorParams.spacingMm };
      const filmTextureByItemId = buildFilmTextureMap(effective, job.items);
      const newViolations = effective.flatMap((s) =>
        validateSheetPlacements({
          sheetIndex: s.sheetIndex,
          placements: s.placements,
          gap,
          filmTextureByItemId,
        }),
      );
      setViolations(newViolations);
    },
    [job],
  );

  const handleEditorChange = useCallback(
    (nextSheets: { sheetIndex: number; placements: SheetPlacements }[]) => {
      // Drop sheets emptied by a cross-sheet move: empty sheets are not wanted in
      // a group. Real sheet_index is preserved for survivors (no renumber) so the
      // moves still validate against the auto stock on save; the editor just stops
      // rendering the blank sheet immediately. Mirrors reconstructManualSheets.
      const effective = pruneEmptySheets(nextSheets);
      // One undo entry per committed gesture: snapshot the PRE-change sheets.
      setEditorHistory((h) => pushHistory(h, workingSheets));
      applyEditorSheets(effective);
    },
    [applyEditorSheets, workingSheets],
  );

  const addEditorSheet = useCallback(() => {
    const base = workingSheets[0]?.placements;
    if (!base) return;
    const sheetIndex = nextSheetIndex(workingSheets);
    const next = [...workingSheets, cloneEmptySheet(base, sheetIndex)];
    setEditorHistory((h) => pushHistory(h, workingSheets));
    setEditorSheetRotations((current) => ({ ...current, [sheetIndex]: 0 }));
    setEditorSheetMirrors((current) => ({ ...current, [sheetIndex]: { horizontal: false, vertical: false } }));
    applyEditorSheets(next);
  }, [applyEditorSheets, workingSheets]);

  const removeEditorSheet = useCallback(
    (sheetIndex: number) => {
      const target = workingSheets.find((sheet) => sheet.sheetIndex === sheetIndex);
      if (!target || target.placements.pieces.length > 0 || workingSheets.length <= 1) return;
      const next = workingSheets.filter((sheet) => sheet.sheetIndex !== sheetIndex);
      setEditorHistory((h) => pushHistory(h, workingSheets));
      setEditorSheetRotations((current) => {
        const nextRotations = { ...current };
        delete nextRotations[sheetIndex];
        return nextRotations;
      });
      setEditorSheetMirrors((current) => {
        const nextMirrors = { ...current };
        delete nextMirrors[sheetIndex];
        return nextMirrors;
      });
      applyEditorSheets(next);
    },
    [applyEditorSheets, workingSheets],
  );

  /** Undo the last committed drag/rotate (up to EDITOR_UNDO_LIMIT steps). */
  const undoEditorStep = useCallback(() => {
    if (editorHistory.length === 0) return;
    const prev = editorHistory[editorHistory.length - 1];
    setEditorHistory(editorHistory.slice(0, -1));
    applyEditorSheets(prev);
  }, [editorHistory, applyEditorSheets]);

  /**
   * Save the manual layout for a group: derives moves from workingSheets,
   * sends PATCH /manual-layout, refetches the job, and clears the editor.
   * resetSheetViews() ensures the next preview fetch is never served a stale
   * blob (Codex R7 / R9 — "manual already active → edit → save again" bust).
   */
  const saveManualLayoutForGroup = useCallback(
    async (group: CutGroupDto) => {
      if (!job || !job.editorParams) return;
      const moves = movesFromSheets(workingSheets);
      const request = {
        jobVersion: job.version,
        active: true,
        placements: moves,
        sheetTransforms: workingSheets.map(({ sheetIndex }) => ({
          sheetIndex,
          rotationDeg: (editorSheetRotations[sheetIndex] ?? 0) as 0 | 90 | 180 | 270,
          mirrorHorizontal: editorSheetMirrors[sheetIndex]?.horizontal ?? false,
          mirrorVertical: editorSheetMirrors[sheetIndex]?.vertical ?? false,
        })),
      };
      const commandKey = JSON.stringify([job.cutJobId, group.cutGroupId, request]);
      if (manualCommandRef.current?.key !== commandKey) {
        manualCommandRef.current = { key: commandKey, commandId: crypto.randomUUID() };
      }
      setBusy(true);
      try {
        // After a manual edit the saved layout becomes the active one and the
        // alternative (manual) view is shown by default (active: true + toggle on).
        const updated = await cutApi.saveManualLayout(job.cutJobId, group.cutGroupId, {
          ...request,
          commandId: manualCommandRef.current.commandId,
        });
        manualCommandRef.current = null;
        setJob(updated);
        setSelectedResult(updated.currentCutResult ?? null);
        setIsFrozenResultSelection(false);
        applyPdfTemplateState(updated);
        emitCutJobUpdate(updated, job);
        setShowAlternativeByGroup((prev) => ({ ...prev, [group.cutGroupId]: true }));
        void loadJobs();
        resetSheetViews();
        setEditingGroupId(null);
        setWorkingSheets([]);
        setViolations([]);
        setEditorHistory([]);
      } catch (error) {
        // Surface 422 violations + 409 recalc/stale with the backend message.
        handleError(error, 'Не удалось сохранить ручной раскрой');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, editorSheetMirrors, editorSheetRotations, emitCutJobUpdate, job, workingSheets, loadJobs, handleError, resetSheetViews],
  );

  const resetCutJobListFilters = useCallback(() => {
    setCutListDateRange(undefined);
    setJobOrderSearch('');
    setAppliedJobOrderSearch('');
    setAppliedCutListDateRange(undefined);
    setJobSearch('');
    setOperationalSheetFilter(undefined);
    setOperationalFilmFilter(undefined);
    setProfileFilter(undefined);
    listFiltersRef.current = {};
    void loadJobs({});
  }, [loadJobs]);

  const cutJobListFiltersActive = Boolean(
    cutListDateRange?.[0] ||
    cutListDateRange?.[1] ||
    appliedCutListDateRange?.[0] ||
    appliedCutListDateRange?.[1] ||
    jobOrderSearch.trim() ||
    appliedJobOrderSearch.trim() ||
    jobSearch.trim() ||
    operationalSheetFilter ||
    operationalFilmFilter ||
    profileFilter,
  );

  const filteredJobs = useMemo(() => {
    const statusFiltered = statusFilter === 'work'
      ? jobs.filter((candidate) => candidate.status === 'draft' || candidate.status === 'calculating')
      : filterJobsByStatus(jobs, statusFilter);
    const profileFiltered = isEmbeddedOrder
      ? statusFiltered
      : filterJobsByProfile(statusFiltered, profileFilter);
    const scoped = !isEmbeddedOrder ? profileFiltered : profileFiltered.filter((candidate) =>
      embeddedJobIds?.has(candidate.cutJobId) ||
      candidate.items?.some((item) => item.orderId === embeddedOrderId),
    );
    const query = jobSearch.trim().toLocaleLowerCase('ru-RU');
    const useJobListFilters = !isEmbeddedOrder;
    return scoped.filter((candidate) => {
      if (
        query &&
        !`${candidate.cutJobId} ${formatCutJobDisplayNumber(candidate, profiles)} ${candidate.name} ${candidate.materialNames.join(' ')}`
          .toLocaleLowerCase('ru-RU')
          .includes(query)
      ) {
        return false;
      }
      if (useJobListFilters && !cutJobMatchesOrderFilter(candidate, appliedJobOrderSearch)) {
        return false;
      }
      if (useJobListFilters && !cutJobCreatedAtInRange(candidate.createdAt, appliedCutListDateRange)) {
        return false;
      }
      if (useJobListFilters && !cutJobMatchesSheetMaterial(candidate, operationalSheetFilter)) {
        return false;
      }
      if (
        useJobListFilters &&
        operationalFilmFilter &&
        !candidate.items.some((item) => item.detail?.filmId === operationalFilmFilter)
      ) {
        return false;
      }
      return true;
    });
  }, [
    embeddedJobIds,
    embeddedOrderId,
    appliedCutListDateRange,
    appliedJobOrderSearch,
    isEmbeddedOrder,
    jobSearch,
    jobs,
    operationalFilmFilter,
    operationalSheetFilter,
    profileFilter,
    profiles,
    statusFilter,
  ]);

  useEffect(() => {
    if (
      !isOperational
      || !isEmbeddedOrder
      || jobsLoading
      || busy
      || job
      || !filteredJobs[0]
    ) {
      return;
    }
    void openJob(filteredJobs[0].cutJobId);
  }, [busy, filteredJobs, isEmbeddedOrder, isOperational, job, jobsLoading, openJob]);

  const jobsSummary = useMemo(() => ({
    total: jobs.filter((candidate) => candidate.status !== 'archived').length,
    ready: jobs.filter((candidate) => candidate.status === 'ready').length,
    inProgress: jobs.filter((candidate) => candidate.status === 'draft' || candidate.status === 'calculating').length,
    failed: jobs.filter((candidate) => candidate.status === 'failed').length,
    archived: jobs.filter((candidate) => candidate.status === 'archived').length,
    sheets: jobs
      .filter((candidate) => candidate.status === 'ready')
      .reduce((total, candidate) => total + (candidate.totals.sheets ?? 0), 0),
  }), [jobs]);
  const exportJobs = useCallback(() => {
    const cells = [
      ['#', 'Дата', 'Название', 'Статус', 'Источник', 'Позиции', 'Заказы', 'Детали', 'Площадь', 'Листы', 'Количество плёнки', 'Профиль', 'Материал'],
      ...filteredJobs.map((candidate) => [
        formatCutJobDisplayNumber(candidate, profiles),
        formatCutJobCreatedDate(candidate.createdAt),
        candidate.name,
        cutJobStatusLabel(candidate.status),
        cutJobSourceLabel(candidate.source),
        candidate.totals.positions,
        cutJobOrderRefs(candidate.items).map(cutJobOrderLabel).join(', '),
        candidate.totals.details,
        candidate.totals.area,
        candidate.status === 'ready' ? candidate.totals.sheets : '',
        totalFilmUsageMeters(candidate.totals.filmUsage) > 0
          ? formatFilmLinearMeters(totalFilmUsageMeters(candidate.totals.filmUsage))
          : '',
        resolveProfileLabel(candidate.paramProfileId, profiles, cutSettings),
        candidate.materialNames.join(', '),
      ]),
    ];
    const csv = cells
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(';'))
      .join('\n');
    triggerBlobDownload(
      new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }),
      `cut-jobs-${dayjs().format('YYYY-MM-DD')}.csv`,
    );
  }, [cutSettings, filteredJobs, profiles]);

  // Memoized film-texture map for the active editor — avoids rebuilding a new Map
  // on every render in edit mode (the SheetEditor prop would otherwise change ref).
  const editorFilmTextureByItemId = useMemo(
    () => buildFilmTextureMap(workingSheets, job?.items ?? []),
    [workingSheets, job?.items],
  );

  // The group currently open in the editor (used to pass material/film target to SheetEditor).
  const editingGroup = useMemo(
    () => job?.groups.find((g) => g.cutGroupId === editingGroupId) ?? null,
    [job, editingGroupId],
  );

  // Per-piece material/film map for the cross-sheet move guard in SheetEditor.
  // Effective material mirrors the backend sheet-override semantics — see
  // buildPieceMetaByItemId (unit-tested against moveAllowed).
  const pieceMetaByItemId = useMemo(
    () => buildPieceMetaByItemId(job?.items ?? [], job?.sheetMaterialTypeId ?? null),
    [job?.items, job?.sheetMaterialTypeId],
  );

  // Per-piece sheet-material and film NAMES for the editor's per-sheet header.
  // Keyed by item_id "det-<orderDetailId>" (materialName is the sheet material,
  // Variant-B sole order-material ref).
  const pieceSheetInfoByItemId = useMemo(() => {
    const m = new Map<string, { materialName: string | null; filmName: string | null }>();
    for (const it of job?.items ?? []) {
      m.set(`det-${it.orderDetailId}`, {
        materialName: it.detail?.materialName ?? null,
        filmName: it.detail?.filmName ?? null,
      });
    }
    return m;
  }, [job?.items]);

  // Memoized label-info map for the active editor: keyed by piece.item_id ("det-N"),
  // provides orderName, orderId, detailNumber and qty for the 3-line piece label.
  const editorLabelInfoByItemId = useMemo(() => {
    const map = new Map<string, { orderName: string | null; orderId: number | null; detailNumber: number | null; qty: number | null }>();
    for (const item of job?.items ?? []) {
      const key = `det-${item.orderDetailId}`;
      if (!map.has(key)) {
        map.set(key, {
          orderName: item.orderName ?? null,
          orderId: item.orderId,
          detailNumber: item.detail?.detailNumber ?? null,
          qty: item.qty ?? null,
        });
      }
    }
    return map;
  }, [job?.items]);

  const jobColumns: ColumnsType<CutJobDto> = useMemo(
    () => [
      {
        title: '#',
        dataIndex: 'cutJobId',
        key: 'id',
        width: 70,
        render: (_: unknown, row: CutJobDto) => formatCutJobDisplayNumber(row, profiles),
      },
      {
        title: 'Дата',
        dataIndex: 'createdAt',
        key: 'createdAt',
        width: 92,
        sorter: (a, b) => cutJobCreatedAtSortValue(a.createdAt) - cutJobCreatedAtSortValue(b.createdAt),
        render: (value: string) => (
          <Tooltip title={formatCutJobCreatedDateTime(value)}>
            <span>{formatCutJobCreatedDate(value)}</span>
          </Tooltip>
        ),
      },
      {
        title: 'Название',
        dataIndex: 'name',
        key: 'name',
        width: isOperational ? 300 : 340,
        className: 'cut-jobs-name-cell',
        render: (value: string) => isOperational ? (
          <span className="cut-jobs-name">
            <strong>{value}</strong>
            <small>обновлено в текущей сессии</small>
          </span>
        ) : value,
      },
      {
        title: 'Статус',
        key: 'status',
        width: 120,
        render: (_: unknown, row: CutJobDto) => {
          const tag = <Tag color={STATUS_TAG_COLORS[row.status] ?? 'default'}>{cutJobStatusLabel(row.status)}</Tag>;
          // A failed job carries a human-readable reason — surface it on hover so
          // the bare red "Ошибка" tag is never an unexplained dead end.
          return row.status === 'failed' && row.failureReason ? (
            <Tooltip title={row.failureReason}>{tag}</Tooltip>
          ) : (
            tag
          );
        },
      },
      {
        title: 'Источник',
        key: 'source',
        width: 100,
        render: (_: unknown, row: CutJobDto) => cutJobSourceLabel(row.source),
      },
      {
        title: 'Позиции',
        key: 'positions',
        width: 63,
        render: (_: unknown, row: CutJobDto) => row.totals.positions,
      },
      {
        title: 'Заказы',
        key: 'orders',
        width: 180,
        render: (_: unknown, row: CutJobDto) => (
          <CutJobOrderLinks
            items={row.items}
            onOpen={(orderId) => show('orders_view', orderId, 'push')}
          />
        ),
      },
      ...(!isOperational ? [{
        title: 'Группы',
        key: 'groups',
        width: 56,
        render: (_: unknown, row: CutJobDto) => cutJobCounts(row).groups,
      }] : []),
      {
        title: 'Деталей',
        key: 'details',
        width: 63,
        sorter: (a, b) => a.totals.details - b.totals.details,
        render: (_: unknown, row: CutJobDto) => row.totals.details,
      },
      {
        title: isOperational ? 'Площадь, м²' : 'Площадь, итого',
        key: 'area',
        width: 84,
        sorter: (a, b) => a.totals.area - b.totals.area,
        render: (_: unknown, row: CutJobDto) => formatArea(row.totals.area),
      },
      {
        title: isOperational ? 'Листы' : 'Кол-во листов раскроя',
        key: 'sheets',
        width: 84,
        render: (_: unknown, row: CutJobDto) => (row.status === 'ready' ? row.totals.sheets : '—'),
      },
      {
        title: 'Количество плёнки',
        key: 'filmUsage',
        width: 118,
        sorter: (a, b) => totalFilmUsageMeters(a.totals.filmUsage) - totalFilmUsageMeters(b.totals.filmUsage),
        render: (_: unknown, row: CutJobDto) => {
          const total = totalFilmUsageMeters(row.totals.filmUsage);
          if (row.status !== 'ready' || total <= 0) return '—';
          const title = filmUsageTooltip(row.totals.filmUsage);
          const value = <Text strong className="app-tabular">{formatFilmLinearMeters(total)}</Text>;
          return title ? <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{title}</span>}>{value}</Tooltip> : value;
        },
      },
      {
        title: 'Профиль',
        key: 'profile',
        width: 180,
        render: (_: unknown, row: CutJobDto) => resolveProfileLabel(row.paramProfileId, profiles, cutSettings),
      },
      {
        title: isOperational ? 'Материал' : 'Материал деталей',
        key: 'detailMaterials',
        width: '20ch',
        render: (_: unknown, row: CutJobDto) => {
          const label = formatJobMaterialNames(row.materialNames);
          return label === '—' ? (
            label
          ) : (
            <Tooltip title={label}>
              <Text className="cut-job-materials-cell">{label}</Text>
            </Tooltip>
          );
        },
      },
      {
        title: 'Действия',
        key: 'actions',
        width: isOperational ? 118 : 200,
        render: (_: unknown, row: CutJobDto) => (
          <Space className="cut-jobs-actions" size={6}>
            <Button size="small" type="link" onClick={() => openJob(row.cutJobId)} disabled={busy}>
              Открыть
            </Button>
            {canManage && !isOperational ? (
              <Button size="small" type="link" danger onClick={() => archiveJob(row)} disabled={busy}>
                Архивировать
              </Button>
            ) : null}
            {isOperational ? (
              <Tooltip title="Дополнительные действия">
                <Button aria-label="Дополнительные действия" type="text" size="small" icon={<MoreOutlined />} />
              </Tooltip>
            ) : null}
          </Space>
        ),
      },
    ],
    [busy, canManage, openJob, archiveJob, profiles, cutSettings, isOperational, show],
  );

  const eligibleColumns: ColumnsType<EligibleDetailDto> = useMemo(
    () => {
      const rows = eligible ?? [];
      const dash = cutDetailCellText;
      const sizeText = (row: EligibleDetailDto) =>
        row.width !== null || row.height !== null ? `${dash(row.width)}×${dash(row.height)}` : '—';
      const statusText = (row: EligibleDetailDto) =>
        row.eligible ? 'Готова к раскрою' : (INELIGIBLE_LABELS[row.ineligibleReason ?? ''] ?? row.ineligibleReason);
      const filesText = (row: EligibleDetailDto) =>
        [
          ['Рез', row.linkCuttingFile],
          ['Фото', row.linkCuttingImageFile],
          ['CAD', row.linkCadFile],
          ['PDF', row.linkPdfFile],
        ]
          .filter(([, href]) => Boolean(href))
          .map(([label]) => label)
          .join(', ');
      const width = {
        order: cutDetailColumnWidth(rows, 'Заказ', (row) => row.orderName?.trim() || `#${row.orderId}`, { min: 96, max: 190 }),
        client: cutDetailColumnWidth(rows, 'Клиент', (row) => row.clientName, { min: 88, max: 220 }),
        pos: cutDetailColumnWidth(rows, 'Поз.', (row) => row.detailNumber, { min: 52, max: 70 }),
        name: cutDetailColumnWidth(rows, 'Наименование', (row) => row.detailName, { min: 116, max: 280 }),
        detailId: cutDetailColumnWidth(rows, 'Деталь', (row) => row.orderDetailId, { min: 68, max: 95 }),
        size: cutDetailColumnWidth(rows, 'Размер (Ш×В)', sizeText, { min: 100, max: 125 }),
        qty: cutDetailColumnWidth(rows, 'Кол-во', (row) => row.quantity, { min: 66, max: 82 }),
        area: cutDetailColumnWidth(rows, 'Площадь', (row) => row.area, { min: 76, max: 96 }),
        film: cutDetailColumnWidth(rows, 'Плёнка', (row) => row.filmName, { min: 80, max: 220 }),
        material: cutDetailColumnWidth(rows, 'Материал', (row) => row.materialName, { min: 90, max: 220 }),
        milling: cutDetailColumnWidth(rows, 'Фрезеровка', (row) => row.millingTypeName, { min: 96, max: 190 }),
        edge: cutDetailColumnWidth(rows, 'Кромка', (row) => row.edgeTypeName, { min: 80, max: 160 }),
        productionStatus: cutDetailColumnWidth(rows, 'Статус произв.', (row) => row.productionStatusName, { min: 120, max: 170 }),
        priority: cutDetailColumnWidth(rows, 'Приоритет', (row) => row.priority, { min: 84, max: 105 }),
        joint: cutDetailColumnWidth(rows, 'Соед. заказ', (row) => row.jointOrderId, { min: 96, max: 120 }),
        note: cutDetailColumnWidth(rows, 'Примечание', (row) => row.note, { min: 100, max: 260 }),
        existingJobs: cutDetailColumnWidth(rows, 'Уже в раскроях', cutDetailExistingJobsText, { min: 140, max: 320 }),
        files: cutDetailColumnWidth(rows, 'Файлы', filesText, { min: 72, max: 130 }),
        status: cutDetailColumnWidth(rows, 'Статус', statusText, { min: 130, max: 170 }),
      };
      return [
        {
          title: 'Заказ',
          key: 'order',
          width: width.order,
          fixed: 'left',
          render: (_: unknown, row: EligibleDetailDto) => (
            <Button type="link" size="small" style={{ padding: 0 }} onClick={() => show('orders_view', row.orderId, 'push')}>
              {row.orderName?.trim() || `#${row.orderId}`}
            </Button>
          ),
        },
        { title: 'Клиент', key: 'client', width: width.client, fixed: 'left', render: (_: unknown, row: EligibleDetailDto) => dash(row.clientName) },
        { title: 'Поз.', key: 'pos', width: width.pos, render: (_: unknown, row: EligibleDetailDto) => dash(row.detailNumber) },
        { title: 'Деталь', dataIndex: 'orderDetailId', key: 'detailId', width: width.detailId },
        {
          title: 'Размер (Ш×В)',
          key: 'size',
          width: width.size,
          render: (_: unknown, row: EligibleDetailDto) => sizeText(row),
        },
        { title: 'Кол-во', dataIndex: 'quantity', key: 'qty', width: width.qty },
        { title: 'Площадь', key: 'area', width: width.area, render: (_: unknown, row: EligibleDetailDto) => dash(row.area) },
        { title: 'Плёнка', key: 'film', width: width.film, render: (_: unknown, row: EligibleDetailDto) => dash(row.filmName) },
        { title: 'Материал', key: 'material', width: width.material, render: (_: unknown, row: EligibleDetailDto) => dash(row.materialName) },
        { title: 'Фрезеровка', key: 'milling', width: width.milling, render: (_: unknown, row: EligibleDetailDto) => dash(row.millingTypeName) },
        { title: 'Наименование', key: 'name', width: width.name, render: (_: unknown, row: EligibleDetailDto) => dash(row.detailName) },
        { title: 'Кромка', key: 'edge', width: width.edge, render: (_: unknown, row: EligibleDetailDto) => dash(row.edgeTypeName) },
        { title: 'Статус произв.', key: 'pstatus', width: width.productionStatus, render: (_: unknown, row: EligibleDetailDto) => dash(row.productionStatusName) },
        { title: 'Приоритет', key: 'priority', width: width.priority, render: (_: unknown, row: EligibleDetailDto) => dash(row.priority) },
        { title: 'Соед. заказ', key: 'joint', width: width.joint, render: (_: unknown, row: EligibleDetailDto) => dash(row.jointOrderId) },
        {
          title: 'Примечание',
          key: 'note',
          width: width.note,
          render: (_: unknown, row: EligibleDetailDto) =>
            row.note ? (
              <Tooltip title={row.note}>
                <Text ellipsis style={{ maxWidth: Math.max(80, width.note - 20), display: 'inline-block' }}>{row.note}</Text>
              </Tooltip>
            ) : (
              '—'
            ),
        },
        {
          title: 'Уже в раскроях',
          key: 'existingJobs',
          width: width.existingJobs,
          render: (_: unknown, row: EligibleDetailDto) => {
            const text = cutDetailExistingJobsText(row);
            return text === '—' ? (
              '—'
            ) : (
              <Tooltip title={text}>
                <Text ellipsis style={{ maxWidth: Math.max(110, width.existingJobs - 20), display: 'inline-block' }}>
                  {text}
                </Text>
              </Tooltip>
            );
          },
        },
        {
          title: 'Файлы',
          key: 'files',
          width: width.files,
          render: (_: unknown, row: EligibleDetailDto) => {
            const links: Array<[string, string | null | undefined]> = [
              ['Рез', row.linkCuttingFile],
              ['Фото', row.linkCuttingImageFile],
              ['CAD', row.linkCadFile],
              ['PDF', row.linkPdfFile],
            ];
            const present = links.filter(([, href]) => Boolean(href));
            if (present.length === 0) return '—';
            return (
              <Space size={4} wrap>
                {present.map(([label, href]) => {
                  const safe = safeHttpHref(href);
                  return safe ? (
                    <a key={label} href={safe} target="_blank" rel="noreferrer">{label}</a>
                  ) : (
                    <Text key={label} type="secondary">{label}</Text>
                  );
                })}
              </Space>
            );
          },
        },
        {
          title: 'Статус',
          key: 'status',
          width: width.status,
          fixed: 'right',
          render: (_: unknown, row: EligibleDetailDto) =>
            row.eligible ? (
              <Tag color="green">Готова к раскрою</Tag>
            ) : (
              <Tag color="orange">{INELIGIBLE_LABELS[row.ineligibleReason ?? ''] ?? row.ineligibleReason}</Tag>
            ),
        },
      ];
    },
    [eligible, show],
  );
  const eligibleTableScrollX = useMemo(
    () => tableScrollX(eligibleColumns, CUT_DETAIL_SELECTION_COLUMN_WIDTH),
    [eligibleColumns],
  );

  // Archived jobs are genuinely read-only: all mutate controls are disabled so
  // an operator deep-linked to an archived job (e.g. from the order show Раскрой
  // column via a stale/hand-edited URL) cannot accidentally mutate it.
  const isArchivedJob = job?.status === 'archived' || isHistoricalResult;
  const jobItemDetailIds = useMemo(
    () => job?.items.map((item) => item.orderDetailId).filter((id) => Number.isInteger(id) && id > 0) ?? [],
    [job?.items],
  );
  const { bathCutJobByDetailId: jobBathCutJobByDetailId } = useCutDetailLastReady({
    enabled: canViewCut && jobItemDetailIds.length > 0,
    detailIds: jobItemDetailIds,
  });

  // The details an operator actually reserved into this job (cut_job_item rows),
  // including those staged from the Orders "Добавить в раскрой" action. Showing
  // them is what makes a reopened job legible: "Загрузить подходящие детали" only
  // surfaces the candidate pool, never the selection already in the job.
  const jobItemColumns: ColumnsType<CutJobItemDto> = useMemo(() => {
    const dash = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : String(value));
    return [
      { title: 'Поз.', key: 'pos', width: 60, fixed: 'left', render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.detailNumber) },
      { title: 'Наименование', key: 'name', width: 180, fixed: 'left', render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.detailName) },
      {
        title: 'Заказ',
        dataIndex: 'orderId',
        key: 'order',
        width: 178,
        // Click the order name to open its card as an in-app workspace tab
        // (push = new keep-alive tab, same as the orders list double-click).
        render: (_: unknown, r: CutJobItemDto) => (
          <CutOrderReference
            orderId={r.orderId}
            orderName={r.orderName}
            orderDeleted={r.orderDeleted}
            onOpen={() => show('orders_view', r.orderId, 'push')}
          />
        ),
      },
      { title: 'Деталь', dataIndex: 'orderDetailId', key: 'detailId', width: 90 },
      {
        title: 'Размер (Ш×В)',
        key: 'size',
        width: 130,
        render: (_: unknown, r: CutJobItemDto) =>
          r.detail && (r.detail.width !== null || r.detail.height !== null)
            ? `${dash(r.detail.width)}×${dash(r.detail.height)}`
            : '—',
      },
      { title: 'Кол-во', dataIndex: 'qty', key: 'qty', width: 80 },
      { title: 'Площадь', key: 'area', width: 90, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.area) },
      { title: 'Материал', key: 'material', width: 160, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.materialName) },
      { title: 'Фрезеровка', key: 'milling', width: 140, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.millingTypeName) },
      { title: 'Кромка', key: 'edge', width: 120, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.edgeTypeName) },
      { title: 'Плёнка', key: 'film', width: 140, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.filmName) },
      { title: 'Статус', key: 'pstatus', width: 130, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.productionStatusName) },
      { title: 'Приоритет', key: 'priority', width: 100, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.priority) },
      { title: 'Соед. заказ', key: 'joint', width: 110, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.jointOrderId) },
      {
        title: 'Примечание',
        key: 'note',
        width: 200,
        render: (_: unknown, r: CutJobItemDto) =>
          r.detail?.note ? (
            <Tooltip title={r.detail.note}>
              <Text ellipsis style={{ maxWidth: 180, display: 'inline-block' }}>{r.detail.note}</Text>
            </Tooltip>
          ) : (
            '—'
          ),
      },
      {
        title: 'Файлы',
        key: 'files',
        width: 150,
        render: (_: unknown, r: CutJobItemDto) => {
          const links: Array<[string, string | null | undefined]> = [
            ['Рез', r.detail?.linkCuttingFile],
            ['Фото', r.detail?.linkCuttingImageFile],
            ['CAD', r.detail?.linkCadFile],
            ['PDF', r.detail?.linkPdfFile],
          ];
          const present = links.filter(([, href]) => Boolean(href));
          if (present.length === 0) return '—';
          return (
            <Space size={4} wrap>
              {present.map(([label, href]) => {
                // Fail-closed: only http(s)/app-relative links become clickable;
                // a javascript:/data: stored link renders as inert text (no XSS).
                const safe = safeHttpHref(href);
                return safe ? (
                  <a key={label} href={safe} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                ) : (
                  <Tooltip key={label} title="Небезопасная ссылка — открытие заблокировано">
                    <Text type="secondary" delete>
                      {label}
                    </Text>
                  </Tooltip>
                );
              })}
            </Space>
          );
        },
      },
      {
        title: 'Расчет ванны',
        key: 'bathCutJob',
        width: 150,
        render: (_: unknown, r: CutJobItemDto) => {
          const ref = jobBathCutJobByDetailId.get(r.orderDetailId);
          if (!ref) return '—';
          return (
            <Button
              size="small"
              type="link"
              onClick={() => void openJob(ref.cutJobId, ref.resultNo)}
              disabled={busy}
              title={ref.name}
              style={{ display: 'inline-flex', alignItems: 'flex-start', height: 'auto', padding: 0, whiteSpace: 'normal', textAlign: 'left' }}
            >
              <CutJobVersionLines job={ref} />
            </Button>
          );
        },
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 110,
        fixed: 'right',
        render: (_: unknown, row: CutJobItemDto) =>
          canManage ? (
            <Button size="small" type="link" danger onClick={() => removeJobItem(row.cutJobItemId)} disabled={busy || isArchivedJob}>
              Убрать
            </Button>
          ) : null,
      },
    ];
  }, [busy, canManage, isArchivedJob, jobBathCutJobByDetailId, openJob, removeJobItem, show]);

  const noSheetMsg = noSheetSpecMessage(noSheetSpecCount);
  const isCreationPreview = job === null && eligible !== null;
  const creationPreviewSummary = useMemo(
    () => buildCutPreviewSummary(eligible ?? []),
    [eligible],
  );
  const creationPreviewOrderTintByOrderId = useMemo(
    () => cutPreviewOrderTintByOrderId(eligible ?? []),
    [eligible],
  );
  const jobItemOrderTintByOrderId = useMemo(
    () => cutJobItemOrderTintByOrderId(job?.items ?? []),
    [job?.items],
  );

  // Dirty guard: any group has an active editor session OR its toggle differs
  // from the persisted isActive. While dirty, whole-job PDF is disabled.
  const anyGroupDirty =
    job != null &&
    job.groups.some((g) => {
      if (editingGroupId === g.cutGroupId) return true;
      if (!g.manualLayout) return false;
      return (showAlternativeByGroup[g.cutGroupId] ?? false) !== g.manualLayout.isActive;
    });
  const jobPdfPreviewBlockReason = cutPdfPreviewBlockReason({
    isFrozenResult: isHistoricalResult,
    hasUnsavedChanges: anyGroupDirty,
    requiresRecalc: job?.requiresRecalc ?? false,
  });

  const jobCutResults = job?.cutResults ?? [];
  const primaryCutResult = job?.currentCutResult
    ?? jobCutResults.find((result) => !result.isArchived)
    ?? jobCutResults[0]
    ?? null;
  const operationalManualMode = job != null && (
    editingGroupId != null
    || job.groups.some((group) => group.manualLayout?.isActive && !group.manualLayout.isStale)
  );
  const operationalWaste = job == null
    ? null
    : (() => {
        const values = job.groups
          .map((group) => Number(group.summary?.waste_percent))
          .filter(Number.isFinite);
        return values.length > 0
          ? Math.round(values.reduce((total, value) => total + value, 0) / values.length)
          : null;
      })();
  const jobCardTitle = job ? (isOperational ? (
    <div className="cut-job-operational-title">
      <Text className="cut-job-operational-title__eyebrow">Расчёт и вывод</Text>
      <Text strong>{job.name}</Text>
      <Space size={6}>
        <Tag color={operationalManualMode ? 'orange' : 'blue'}>
          {operationalManualMode ? 'Ручной раскрой' : 'Автоматический'}
        </Tag>
        <Tag color={STATUS_TAG_COLORS[job.status] ?? 'default'}>{cutJobStatusLabel(job.status)}</Tag>
      </Space>
    </div>
  ) : (
    <Space className="cut-job-card-title" size={8} wrap>
      <Text strong>Задание на раскрой {jobDisplayNumber}</Text>
      <Text type="secondary">—</Text>
      {isEditingJobName ? (
        <Space.Compact className="cut-job-name-editor">
          <Input
            size="small"
            value={jobNameDraft}
            onChange={(event) => setJobNameDraft(event.target.value)}
            onPressEnter={() => void saveJobName()}
            maxLength={200}
            autoFocus
            disabled={jobNameSaving}
            data-testid="cut-job-name-input"
          />
          <Tooltip title="Сохранить название">
            <Button
              size="small"
              icon={<SaveOutlined />}
              onClick={() => void saveJobName()}
              loading={jobNameSaving}
              disabled={jobNameSaving}
              data-testid="cut-job-name-save"
            />
          </Tooltip>
          <Tooltip title="Отменить">
            <Button
              size="small"
              icon={<CloseOutlined />}
              onClick={cancelJobNameEdit}
              disabled={jobNameSaving}
              data-testid="cut-job-name-cancel"
            />
          </Tooltip>
        </Space.Compact>
      ) : (
        <>
          <Text className="cut-job-card-name">{job.name}</Text>
          {canManage && !isArchivedJob && (
            <Tooltip title="Редактировать название">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={startJobNameEdit}
                disabled={busy || job.status === 'calculating'}
                data-testid="cut-job-name-edit"
              />
            </Tooltip>
          )}
        </>
      )}
    </Space>
  )) : undefined;

  if (!can('cut.view')) {
    return <Alert type="error" message="Недостаточно прав для просмотра раскроя" showIcon />;
  }

  return (
    <>
      <Space
        className={[
          'cut-page-modern',
          isEmbeddedOrder ? 'cut-page-modern--embedded' : 'cut-page-modern--standalone',
          job ? 'cut-page-modern--detail' : 'cut-page-modern--list',
          isCreationPreview ? 'cut-page-modern--creation-preview' : '',
          criteriaOpen ? 'cut-page-modern--criteria-open' : '',
        ].filter(Boolean).join(' ')}
        direction="vertical"
        size="large"
        style={{ width: '100%' }}
      >
        {isOperational && !isEmbeddedOrder ? (
          <>
            <OperationalPageHeader
              compact
              breadcrumbs={job ? `Производство › Раскрой › Задание ${jobDisplayNumber}` : 'Производство › Раскрой'}
              title={job ? `Задание на раскрой ${jobDisplayNumber}` : 'Раскрой'}
              description={job
                ? `${job.name} · рабочая карточка расчёта и печати производственных материалов.`
                : 'Единый список заданий, версий расчета и производственной готовности.'}
              actions={job ? (
                <>
                  <Button
                    type="text"
                    icon={<HistoryOutlined />}
                    onClick={() => document.querySelector('.cut-results-block')?.scrollIntoView({ behavior: 'smooth' })}
                  >
                    История
                  </Button>
                  <Button
                    icon={<UploadOutlined />}
                    onClick={() => setSvgUploadOpen(true)}
                    disabled={!canManage}
                  >
                    Загрузить SVG
                  </Button>
                  <Button
                    icon={<PrinterOutlined />}
                    onClick={() => void openJobPdfPreview()}
                    disabled={job.groups.length === 0 || jobPdfPreviewBlockReason !== null}
                    loading={busy}
                  >
                    Печать
                  </Button>
                  <Button
                    type="primary"
                    icon={<CheckOutlined />}
                    disabled={job.status !== 'ready'}
                    onClick={() => message.success('Задание готово к следующему производственному этапу')}
                  >
                    Завершить задание
                  </Button>
                </>
              ) : (
                <>
                  <Button icon={<DownloadOutlined />} onClick={exportJobs}>
                    Экспорт
                  </Button>
                  <Button
                    icon={<UploadOutlined />}
                    onClick={() => setSvgUploadOpen(true)}
                    disabled={!canManage}
                  >
                    SVG раскрой
                  </Button>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => setCriteriaOpen((open) => !open)}
                  >
                    {criteriaOpen ? 'Скрыть подбор' : 'Подбор деталей на раскрой'}
                  </Button>
                </>
              )}
            />
            {job ? (
              <OperationalKpiGrid columns={5}>
                <OperationalKpi label="Позиции" value={job.totals.positions} />
                <OperationalKpi label="Детали" value={job.totals.details} />
                <OperationalKpi label="Площадь" value={formatArea(job.totals.area)} tone="info" />
                <OperationalKpi label="Листы" value={job.totals.sheets ?? 0} tone="success" />
                <OperationalKpi
                  label="Остаток"
                  value={operationalWaste == null ? '—' : `${operationalWaste}%`}
                  hint="по текущему профилю"
                  tone={operationalWaste != null && operationalWaste > 25 ? 'warning' : 'neutral'}
                />
              </OperationalKpiGrid>
            ) : (
              <OperationalKpiGrid columns={5}>
                <OperationalKpi label="Сегодня" value={jobsSummary.total} hint="создано заданий" />
                <OperationalKpi label="В работе" value={jobsSummary.inProgress} hint="требуют внимания" tone="info" />
                <OperationalKpi label="Готово" value={jobsSummary.ready} hint="можно печатать" tone="success" />
                <OperationalKpi label="Листов" value={jobsSummary.sheets} hint="в текущем периоде" />
                <OperationalKpi label="Средний остаток" value="—" hint="нет данных" />
              </OperationalKpiGrid>
            )}
          </>
        ) : null}
        {isOperational && isEmbeddedOrder ? (
          <OperationalKpiGrid columns={5}>
            <OperationalKpi label="Заданий на раскрой" value={jobsSummary.total} />
            <OperationalKpi
              label="Назначено деталей"
              value={job ? `${job.totals.details} / ${job.totals.details}` : '0 / 0'}
              tone="info"
            />
            <OperationalKpi label="Площадь" value={job ? formatArea(job.totals.area) : '—'} />
            <OperationalKpi label="Листов" value={job?.totals.sheets ?? jobsSummary.sheets} />
            <OperationalKpi
              label="Готовность"
              value={jobsSummary.total > 0 ? `${Math.round((jobsSummary.ready / jobsSummary.total) * 100)}%` : '0%'}
              tone="success"
            />
          </OperationalKpiGrid>
        ) : null}
        {!isEmbeddedOrder && !isOperational && <Title level={3}>Раскрой</Title>}

      {!isEmbeddedOrder ? (
        <section className="cut-operational-filters operational-panel" aria-label="Фильтры заданий на раскрой">
          <label className="cut-operational-filter cut-operational-filter--period">
            <span>Дата создания</span>
            <RangePicker
              allowClear
              format="DD.MM.YYYY"
              value={cutListDateRange ?? null}
              placeholder={['Создано от', 'Создано до']}
              onChange={(value) => setCutListDateRange(value)}
            />
          </label>
          <label className="cut-operational-filter cut-operational-filter--order">
            <span>Номер заказа</span>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="2700"
              value={jobOrderSearch}
              onChange={(event) => setJobOrderSearch(event.target.value)}
            />
          </label>
          <label className="cut-operational-filter cut-operational-filter--search">
            <span>Название задания</span>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="текст названия"
              value={jobSearch}
              onChange={(event) => setJobSearch(event.target.value)}
            />
          </label>
          <label className="cut-operational-filter">
            <span>Материал</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Все материалы"
              options={visibleSheetTypeOptions}
              value={operationalSheetFilter}
              onChange={setOperationalSheetFilter}
            />
          </label>
          <label className="cut-operational-filter">
            <span>Пленка</span>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Все пленки"
              options={visibleFilmOptions}
              value={operationalFilmFilter}
              onChange={setOperationalFilmFilter}
            />
          </label>
          <label className="cut-operational-filter">
            <span>Профиль раскроя</span>
            <Select<CutJobProfileFilter>
              allowClear
              showSearch
              optionFilterProp="label"
              aria-label="Фильтр по профилю раскроя"
              placeholder="Все профили"
              options={jobProfileFilterOptions}
              value={profileFilter}
              onChange={setProfileFilter}
            />
          </label>
          <Space className="cut-operational-filter-actions">
            <Button
              icon={<FilterOutlined />}
              onClick={() => {
                const trimmedJobSearch = jobSearch.trim();
                const trimmedOrderSearch = jobOrderSearch.trim();
                const filters = buildOperationalListFilters(trimmedOrderSearch, cutListDateRange);
                setJobSearch(trimmedJobSearch);
                setJobOrderSearch(trimmedOrderSearch);
                setAppliedJobOrderSearch(trimmedOrderSearch);
                setAppliedCutListDateRange(cutListDateRange);
                listFiltersRef.current = filters;
                void loadJobs(filters);
              }}
            >
              Применить
            </Button>
            <Button onClick={resetCutJobListFilters} disabled={!cutJobListFiltersActive}>
              Сбросить
            </Button>
          </Space>
        </section>
      ) : null}

      <Card
        className="cut-page-modern__criteria"
        title={isOperational && isEmbeddedOrder ? 'Критерии' : 'Критерии выборки'}
        size="small"
      >
        <Form form={form} layout="inline" disabled={busy || !canManage} initialValues={{ orderDateRange: defaultOrderDateRange }}>
          {!isEmbeddedOrder && (
            <Form.Item name="orderDateRange">
              <RangePicker
                allowClear={false}
                format="DD.MM.YYYY"
                placeholder={['Дата от', 'Дата до']}
                onChange={() => {
                  if (canViewOrders) form.setFieldsValue({ orderIds: undefined });
                  form.setFieldsValue({ filmIds: undefined });
                }}
                style={{ width: 250 }}
                data-testid="cut-order-date-range"
              />
            </Form.Item>
          )}
          {isEmbeddedOrder ? (
            <Form.Item name="orderIds" hidden>
              <Input />
            </Form.Item>
          ) : canViewOrders ? (
            <Form.Item name="orderIds">
              <Select<number[]>
                mode="multiple"
                allowClear
                showSearch
                maxTagCount="responsive"
                placeholder="Заказ"
                options={visibleOrderOptions}
                loading={ordersLoading}
                onChange={() => form.setFieldsValue({ filmIds: undefined })}
                filterOption={(input, option) =>
                  String((option as CutOrderSelectOption | undefined)?.searchText ?? '')
                    .includes(input.trim().toLowerCase())
                }
                style={{ minWidth: 240 }}
                data-testid="cut-order-select"
              />
            </Form.Item>
          ) : (
            <Form.Item name="orderIds">
              <Input placeholder="Заказы (9,10)" onChange={() => form.setFieldsValue({ filmIds: undefined })} />
            </Form.Item>
          )}
          {sheetFilterEnabled && (
            <Form.Item name="sheetMaterialTypeIds">
              <Select<number[]>
                mode="multiple"
                allowClear
                placeholder="Типы листов"
                options={visibleSheetTypeOptions}
                fieldNames={{ label: 'label', value: 'value' }}
                onChange={() => form.setFieldsValue({ filmIds: undefined })}
                style={{ minWidth: 200 }}
                data-testid="cut-sheet-type-filter"
              />
            </Form.Item>
          )}
          <Form.Item name="filmIds">
            <Select<number[]>
              mode="multiple"
              allowClear
              showSearch
              maxTagCount="responsive"
              placeholder="Плёнки"
              options={visibleFilmOptions}
              loading={filmsLoading}
              filterOption={(input, option) =>
                String((option as CutFilmSelectOption | undefined)?.searchText ?? '')
                  .includes(input.trim().toLowerCase())
              }
              notFoundContent={filmsLoading ? <Spin size="small" /> : 'Нет плёнок'}
              style={{ minWidth: 220 }}
              data-testid="cut-film-select"
            />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={previewCreateJob} loading={busy} disabled={!canManage}>
              Подбор деталей на раскрой
            </Button>
          </Form.Item>
        </Form>
      </Card>

      {isCreationPreview && eligible && (
        <Card
          className="cut-page-modern__creation"
          title="Проверка деталей перед созданием"
          size="small"
          extra={
            <Space>
              <Text type="secondary">Выбрано: {selected.length}</Text>
              <Button type="primary" onClick={createJobFromPreview} disabled={!canManage || selected.length === 0} loading={busy}>
                Создать
              </Button>
            </Space>
          }
        >
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Input
              value={previewName}
              onChange={(event) => setPreviewName(event.target.value)}
              placeholder="Название раскроя"
              data-testid="cut-preview-name"
            />
            {noSheetMsg && <Alert type="warning" showIcon message={noSheetMsg} />}
            <TableTopScroll>
              <Table<EligibleDetailDto>
                className="cut-create-preview-details-table"
                size="small"
                rowKey="orderDetailId"
                columns={eligibleColumns}
                dataSource={eligible}
                pagination={false}
                scroll={{ x: eligibleTableScrollX, y: CUT_DETAIL_PREVIEW_TABLE_BODY_HEIGHT }}
                rowClassName={(row) => {
                  const tint = creationPreviewOrderTintByOrderId.get(row.orderId) ?? 0;
                  return `cut-create-preview-order-row cut-create-preview-order-tint-${tint}${row.eligible ? '' : ' cut-create-preview-row-ineligible'}`;
                }}
                rowSelection={{
                  selectedRowKeys: selected,
                  onChange: (keys) => setSelected(keys.map(Number)),
                  getCheckboxProps: (row) => ({ disabled: !row.eligible }),
                }}
                data-testid="cut-create-preview-details"
              />
            </TableTopScroll>
            <div className="cut-create-preview-summary" data-testid="cut-create-preview-summary">
              <div className="cut-create-preview-summary-row">
                <Text strong>Итого по плёнкам и материалам:</Text>
                <Space size={6} wrap>
                  {creationPreviewSummary.groups.length === 0 ? (
                    <Text type="secondary">нет деталей в выборке</Text>
                  ) : (
                    creationPreviewSummary.groups.map((group) => (
                      <Tag key={group.key} color="blue" style={{ whiteSpace: 'normal', lineHeight: 1.5 }}>
                        {group.materialName} / {group.filmName}: {formatCutPreviewSummaryMetrics(group)}
                      </Tag>
                    ))
                  )}
                </Space>
              </div>
              <div className="cut-create-preview-summary-row">
                <Text strong>Итого по всем деталям в выборке:</Text>
                <Text>{formatCutPreviewSummaryMetrics(creationPreviewSummary.total)}</Text>
              </div>
            </div>
          </Space>
        </Card>
      )}

      <Card
        className="cut-page-modern__jobs"
        size="small"
        title={isOperational ? undefined : 'Задания на раскрой'}
        extra={!isOperational ? (
          <Space>
            <Select<string>
              value={statusFilter}
              onChange={setStatusFilter}
              options={[...CUT_JOB_STATUS_FILTER_OPTIONS]}
              style={{ width: 160 }}
            />
            <Select<CutJobProfileFilter>
              allowClear
              showSearch
              optionFilterProp="label"
              aria-label="Фильтр по профилю раскроя"
              placeholder="Все профили"
              options={jobProfileFilterOptions}
              value={profileFilter}
              onChange={setProfileFilter}
              style={{ width: 220 }}
            />
            <Button onClick={loadJobs} loading={jobsLoading}>
              Обновить
            </Button>
          </Space>
        ) : undefined}
      >
        {isOperational && !isEmbeddedOrder ? (
          <div className="cut-operational-table-toolbar">
            <div className="cut-operational-statuses" role="group" aria-label="Статус заданий">
              <Button
                type={statusFilter === CUT_JOB_STATUS_FILTER_ALL ? 'primary' : 'text'}
                onClick={() => setStatusFilter(CUT_JOB_STATUS_FILTER_ALL)}
              >
                Все
              </Button>
              <Button
                type={statusFilter === 'work' ? 'primary' : 'text'}
                onClick={() => setStatusFilter('work')}
              >
                В работе
              </Button>
              <Button
                type={statusFilter === 'ready' ? 'primary' : 'text'}
                onClick={() => setStatusFilter('ready')}
              >
                Готовы
              </Button>
              <Button
                type={statusFilter === 'archived' ? 'primary' : 'text'}
                onClick={() => setStatusFilter('archived')}
              >
                Архив
              </Button>
            </div>
            <Button className="cut-operational-chip" type="primary">Сегодня</Button>
            <Button className="cut-operational-chip">Мои задания</Button>
            <span className="cut-operational-table-toolbar__grow" />
            <Typography.Text type="secondary">Найдено {filteredJobs.length}</Typography.Text>
            <Tooltip title="Обновить">
              <Button aria-label="Обновить список" icon={<ReloadOutlined />} onClick={loadJobs} loading={jobsLoading} />
            </Tooltip>
            <Tooltip title="Плотность строк">
              <Button aria-label="Плотность строк" icon={<ColumnHeightOutlined />} />
            </Tooltip>
          </div>
        ) : null}
        {isOperational && isEmbeddedOrder ? (
          <div className="cut-jobs-operational-list">
            {jobsLoading ? <Spin /> : filteredJobs.length === 0 ? (
              <Text type="secondary">Нет заданий для этого заказа</Text>
            ) : filteredJobs.map((candidate) => (
              <button
                key={candidate.cutJobId}
                type="button"
                className={`cut-jobs-operational-list__item${candidate.cutJobId === job?.cutJobId ? ' is-active' : ''}`}
                onClick={() => {
                  if (!busy) void openJob(candidate.cutJobId);
                }}
              >
                <span className="cut-jobs-operational-list__head">
                  <strong>{`${formatCutJobDisplayNumber(candidate, profiles)} · ${candidate.name}`}</strong>
                  <Tag color={STATUS_TAG_COLORS[candidate.status] ?? 'default'}>
                    {cutJobStatusLabel(candidate.status)}
                  </Tag>
                </span>
                <span>
                  {candidate.totals.positions} позиций · {candidate.totals.details} деталей
                </span>
                <span>
                  {candidate.status === 'ready' ? `${candidate.totals.sheets} листов` : 'Ожидает расчета'} · {formatArea(candidate.totals.area)}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="cut-jobs-table-container" style={{ maxHeight: CUT_JOBS_TABLE_CONTAINER_HEIGHT }}>
            <Table<CutJobDto>
              className="cut-jobs-table"
              size="small"
              rowKey="cutJobId"
              columns={jobColumns}
              dataSource={filteredJobs}
              loading={jobsLoading}
              pagination={false}
              locale={{ emptyText: 'Нет раскроев' }}
              rowSelection={isOperational ? { columnWidth: 38 } : undefined}
              rowClassName={(row) => (row.cutJobId === job?.cutJobId ? 'ant-table-row-selected' : '')}
              onRow={(row) => ({
                onDoubleClick: () => {
                  if (!busy) void openJob(row.cutJobId);
                },
              })}
            />
          </div>
        )}
      </Card>

      {job && (
        <Card
          className="cut-page-modern__job"
          size="small"
          title={isOperational && embeddedOrderId == null ? undefined : jobCardTitle}
          extra={
            isOperational && embeddedOrderId == null
              ? undefined
              : <Tag color={STATUS_TAG_COLORS[job.status] ?? 'default'}>{cutJobStatusLabel(job.status)}</Tag>
          }
        >
          <div className="cut-job-overview">
            <aside className="cut-job-overview__history">
              <div
                className="cut-results-block"
                data-testid="cut-results-block"
                aria-label="Выполненные раскрои"
              >
                <div className="cut-results-block-title">
                  <span>Версии расчёта</span>
                  <ReloadOutlined />
                </div>
                {jobCutResults.length > 0 ? (
                  isOperational ? (
                    <div className="cut-results-operational-list">
                      {jobCutResults.map((result) => (
                        <div
                          key={result.cutResultId}
                          className={[
                            'cut-results-operational-list__item',
                            result.isCurrent ? 'is-current' : '',
                            result.isArchived ? 'is-archived' : '',
                          ].filter(Boolean).join(' ')}
                        >
                          <button
                            type="button"
                            disabled={busy || (isFrozenResultSelection && selectedResult?.cutResultId === result.cutResultId)}
                            onClick={() => void openResult(result)}
                          >
                            <span className="cut-results-operational-list__icon"><DownloadOutlined /></span>
                            <span>
                              <strong>{`${result.cutNumber} · ${result.resultKind === 'manual' ? 'Ручной' : 'Авто'}`}</strong>
                              <small>{new Date(result.createdAt).toLocaleString('ru-RU')}</small>
                            </span>
                            <Space size={4} wrap>
                              {result.isCurrent ? <Tag color="green">Действующий</Tag> : <b>Открыть</b>}
                              {result.isArchived && <Tag>Архив</Tag>}
                            </Space>
                          </button>
                          <Space size={4} wrap className="cut-results-operational-list__actions">
                            {!result.isCurrent && !result.isArchived && (
                              <Button size="small" type="link" disabled={busy} onClick={() => void setCurrentResult(result)}>
                                Сделать действующим
                              </Button>
                            )}
                            {result.isArchived ? (
                              <Button size="small" type="link" disabled={busy} onClick={() => void unarchiveResult(result)}>
                                Вернуть
                              </Button>
                            ) : (
                              <Button size="small" type="link" danger disabled={busy || result.isCurrent} onClick={() => void archiveResult(result)}>
                                В архив
                              </Button>
                            )}
                          </Space>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <Table<CutResultSummary>
                        className="cut-results-latest-table"
                        size="small"
                        rowKey="cutResultId"
                        pagination={false}
                        dataSource={primaryCutResult ? [primaryCutResult] : []}
                        columns={cutResultColumns}
                      />
                      {jobCutResults.length > 1 && (
                        <Collapse size="small" className="cut-results-history-collapse" defaultActiveKey={[]}>
                          <Panel header={`Все сохранённые раскрои (${jobCutResults.length})`} key="cut-results-history">
                            <Table<CutResultSummary>
                              size="small"
                              rowKey="cutResultId"
                              pagination={false}
                              dataSource={jobCutResults}
                              columns={cutResultColumns}
                            />
                          </Panel>
                        </Collapse>
                      )}
                    </>
                  )
                ) : (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Расчётов пока нет" />
                )}
              </div>
              {isOperational && embeddedOrderId == null ? (
                <div className="cut-results-operational-summary">
                  <Text strong>Сводка</Text>
                  <dl>
                    <div><dt>Заказы</dt><dd><CutJobOrderLinks items={job.items} onOpen={(orderId) => show('orders_view', orderId, 'push')} /></dd></div>
                    <div><dt>Материалов</dt><dd>{job.totals.materialsCount}</dd></div>
                    <div><dt>Плёнок</dt><dd>{job.totals.filmsCount}</dd></div>
                    <div><dt>Автор</dt><dd>{authSession.getUser()?.username ?? '—'}</dd></div>
                  </dl>
                </div>
              ) : null}
            </aside>
            <section className="cut-job-overview__main">
              {isOperational && embeddedOrderId == null ? (
                <div className="cut-job-operational-main-head">
                  {jobCardTitle}
                  <Tooltip title="Параметры задания">
                    <Button
                      aria-label="Параметры задания"
                      icon={<EditOutlined />}
                      onClick={() => document.querySelector('.cut-job-operational-fields')?.scrollIntoView({ block: 'center' })}
                    />
                  </Tooltip>
                </div>
              ) : null}
              {isHistoricalResult && selectedResult && (
                <Alert
                  type="info"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={`${selectedResult.isCurrent ? 'Действующая версия' : 'Историческая версия'} ${selectedResult.cutNumber}`}
                  description={selectedResult.isCurrent
                    ? 'Действующая версия выбрана из сохранённых раскроев и доступна только для просмотра.'
                    : 'Версия доступна только для просмотра. Изменения выполняются в действующем раскрое.'}
                  action={(
                    <Button
                      size="small"
                      onClick={returnToCurrentResult}
                    >
                      Вернуться к живому заданию
                    </Button>
                  )}
                />
              )}
              {isOperational && (
                <Alert
                  className="cut-job-operational-state"
                  type={operationalManualMode ? 'warning' : 'success'}
                  showIcon
                  message={operationalManualMode
                    ? 'Ручной раскрой активен. Сравните остаток с автоматическим вариантом перед печатью.'
                    : `Профиль применён. ${job.totals.sheets} листов рассчитаны и готовы к печати.`}
                />
              )}
          {job.status === 'failed' && job.failureReason && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="Не удалось рассчитать раскрой"
              description={`${job.failureReason}${job.currentCutResult ? ` Последний успешный раскрой: ${job.currentCutResult.cutNumber}.` : ''}`}
            />
          )}
          {job.autoLayoutValidation?.valid === false && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="Требуется пересчёт раскроя"
              description="Раскрой создан старой версией оптимизатора и содержит некорректные зазоры. Пересчитайте задание перед ручным редактированием."
              data-testid="legacy-auto-layout-warning"
            />
          )}
          {(() => {
            const activeOptions = profiles
              .filter((p) => p.isActive)
              .map((p) => ({ value: p.cutParamProfileId, label: (<Tooltip title={describeCutProfile(p.params)}>{resolveProfileLabel(p.cutParamProfileId, profiles, cutSettings)}</Tooltip>) }));
            const chosen = job.paramProfileId;
            const chosenInactive = chosen !== null && !profiles.some((p) => p.cutParamProfileId === chosen && p.isActive);
            const chosenInactiveProfile = chosenInactive ? profiles.find((p) => p.cutParamProfileId === chosen) : undefined;
            const profileOptions = chosenInactive
              ? [...activeOptions, { value: chosen, label: (<Tooltip title={describeCutProfile(chosenInactiveProfile?.params ?? {})}>{resolveProfileLabel(chosen, profiles, cutSettings)}</Tooltip>), disabled: true }]
              : activeOptions;
            return (
              <>
                <Space className="cut-job-operational-stats" size="large" style={{ marginBottom: 12 }} wrap>
                  <span>Позиции: <b>{job.totals.positions}</b></span>
                  <span>Заказы: <CutJobOrderLinks items={job.items} onOpen={(orderId) => show('orders_view', orderId, 'push')} /></span>
                  <span>Деталей: <b>{job.totals.details}</b></span>
                  <span>Материалов: <b>{job.totals.materialsCount}</b></span>
                  <span>Плёнок: <b>{job.totals.filmsCount}</b></span>
                  <span>Площадь, итого: <b>{formatArea(job.totals.area)}</b></span>
                  {job.status === 'ready' && <span>Листов раскроя: <b>{job.totals.sheets}</b></span>}
                  {totalFilmUsageMeters(job.totals.filmUsage) > 0 && (
                    <span>Количество плёнки: <b>{formatFilmLinearMeters(totalFilmUsageMeters(job.totals.filmUsage))}</b></span>
                  )}
                </Space>
                <div className="cut-job-operational-fields" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <span style={{ marginRight: 8 }}>Профиль раскроя:</span>
                    <Select<number | null>
                      value={job.paramProfileId}
                      onChange={(v) => void setJobProfile(v ?? null)}
                      disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                      style={{ minWidth: 240 }}
                      placeholder={resolveProfileLabel(null, profiles, cutSettings)}
                      allowClear
                      options={profileOptions}
                    />
                    {job.status === 'ready' && (
                      <div style={{ marginTop: 4, color: '#ad8b00', whiteSpace: 'nowrap' }}>
                        изменение профиля применится после команды «Рассчитать»
                      </div>
                    )}
                  </div>
                  {(() => {
                    const jobMt = jobMaterialTypeIds(job.items.map((i) => i.detail?.sheetMaterialTypeId ?? null), sheetOptions);
                    const { preferred, others } = partitionSheetOptions(sheetOptions, jobMt);
                    const grouped = [
                      // Explicit default = clear the override so detail materials are used
                      // (in addition to the field's ✕ clear). Re-enables «Разделять по материалу».
                      { value: null as number | null, label: 'Как у деталей (по умолчанию)' },
                      ...(preferred.length ? [{ label: 'Материал деталей', options: preferred.map((o) => ({ value: o.sheetMaterialTypeId, label: formatSheetOptionLabel(o) })) }] : []),
                      ...(others.length ? [{ label: 'Другие листы', options: others.map((o) => ({ value: o.sheetMaterialTypeId, label: formatSheetOptionLabel(o) })) }] : []),
                    ];
                    const mixed = isMixedMaterialSelection(job.sheetMaterialTypeId, sheetOptions, jobMt);
                    return (
                      <div>
                        <span style={{ marginRight: 8 }}>Лист раскроя:</span>
                        <Select<number | null>
                          value={job.sheetMaterialTypeId}
                          onChange={(v) => void setJobSheetMaterial(v ?? null)}
                          disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                          style={{ minWidth: 280 }}
                          placeholder="Как у деталей"
                          allowClear
                          options={grouped}
                        />
                        {mixed && !job.splitByMaterial && (
                          <Alert
                            type="warning"
                            showIcon
                            style={{ marginTop: 8, maxWidth: 360 }}
                            message="«Разделять по материалу» выключено: все детали разных материалов будут раскроены на одном выбранном листе"
                          />
                        )}
                        {(job.sheetFitWarnings?.length ?? 0) > 0 && (
                          <div
                            data-testid="cut-sheet-fit-warning"
                            role="alert"
                            aria-live="polite"
                            style={{
                              color: token.colorError,
                              fontSize: 12,
                              lineHeight: 1.35,
                              marginTop: 6,
                              maxWidth: 520,
                            }}
                          >
                            <strong>
                              На выбранный лист {job.sheetFitWarnings![0].sheetWidthMm}×{job.sheetFitWarnings![0].sheetHeightMm} мм
                              {' '}(рабочее поле {job.sheetFitWarnings![0].usableWidthMm}×{job.sheetFitWarnings![0].usableHeightMm} мм)
                              {' '}не помещаются детали: {job.sheetFitWarnings!.length}.
                            </strong>
                            <ul style={{ margin: '3px 0 0', paddingInlineStart: 18 }}>
                              {job.sheetFitWarnings!.map((warning) => (
                                <li key={warning.orderDetailId}>
                                  Заказ {warning.orderId}, деталь {warning.detailNumber ?? `#${warning.orderDetailId}`}
                                  {warning.detailName ? ` «${warning.detailName}»` : ''}, {warning.widthMm}×{warning.heightMm} мм —{' '}
                                  {warning.reason === 'orientation'
                                    ? 'помещается только после поворота на 90°, но расчёт запрещает поворот'
                                    : 'превышает рабочий размер листа даже с поворотом'}.
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div className="cut-job-operational-options" style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <Tooltip title="разные материалы кроятся отдельными группами; выключите, чтобы раскроить все детали вместе в одной группе; применится после команды «Рассчитать»">
                      <Checkbox
                        checked={job.splitByMaterial}
                        onChange={(e) => void setJobSplitByMaterial(e.target.checked)}
                        disabled={
                          !canManage ||
                          busy ||
                          job.status === 'calculating' ||
                          isArchivedJob ||
                          isVacuumTableProfile(job.paramProfileId, profiles) ||
                          job.sheetMaterialTypeId != null
                        }
                      >
                        Разделять по материалу
                      </Checkbox>
                    </Tooltip>
                    {job.sheetMaterialTypeId != null && (
                      <div style={{ color: '#fa8c16', fontSize: 12, marginTop: 2, maxWidth: 280 }}>
                        Весь раскрой на выбранном листе.
                      </div>
                    )}
                  </div>
                  <div>
                    <Tooltip title="детали одного материала с разными плёнками кроятся вместе; применится после команды «Рассчитать»">
                      <Checkbox
                        checked={job.combineFilms}
                        onChange={(e) => void setJobCombineFilms(e.target.checked)}
                        disabled={
                          !canManage ||
                          busy ||
                          job.status === 'calculating' ||
                          isArchivedJob ||
                          isVacuumTableProfile(job.paramProfileId, profiles)
                        }
                      >
                        Объединить разные плёнки
                      </Checkbox>
                    </Tooltip>
                  </div>
                  <div>
                    <Tooltip title="если выключено, расчёт раскроя запрещает поворот всех деталей на 90°; применится после команды «Рассчитать»">
                      <Checkbox
                        checked={job.rotationAllowed}
                        onChange={(e) => void setJobRotationAllowed(e.target.checked)}
                        disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                      >
                        Поворот разрешён
                      </Checkbox>
                    </Tooltip>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Text type="secondary">Направление текстуры</Text>
                    <Tooltip title="Информационное поле для карт раскроя PDF. На расчёт не влияет.">
                      <Select<CutTextureDirection>
                        size="small"
                        style={{ width: 160 }}
                        value={job.textureDirection ?? 'none'}
                        options={CUT_TEXTURE_DIRECTION_OPTIONS}
                        onChange={(value) => void setJobTextureDirection(value)}
                        disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                      />
                    </Tooltip>
                  </div>
                </div>
                {isOperational && operationalManualMode ? (
                  <div className="cut-job-operational-comparison">
                    <div>
                      <span>Текущий ручной</span>
                      <strong>
                        {job.groups.reduce(
                          (total, group) => total + (group.manualLayout?.sheets.length ?? group.sheets.length),
                          0,
                        )} листов
                      </strong>
                      <Tag color="orange">
                        {operationalWaste == null ? 'Остаток —' : `Остаток ${operationalWaste}%`}
                      </Tag>
                    </div>
                    <b>›</b>
                    <div className="is-preferred">
                      <span>Автоматический</span>
                      <strong>{job.groups.reduce((total, group) => total + group.sheets.length, 0)} листов</strong>
                      <Tag color="green">Доступен для сравнения</Tag>
                    </div>
                  </div>
                ) : null}
              </>
            );
          })()}
          <div className="cut-job-operational-actions" style={cutActionToolbarStyle}>
            <Button onClick={loadEligible} loading={busy}>
              Загрузить подходящие детали
            </Button>
            <Button onClick={addToBasket} disabled={!canManage || selected.length === 0 || isArchivedJob} loading={busy}>
              Добавить выбранные ({selected.length})
            </Button>
            <Button type="primary" onClick={calculate} disabled={!canManage || job.items.length === 0 || isArchivedJob} loading={busy}>
              {job.status === 'failed' ? 'Повторить расчёт' : 'Рассчитать'}
            </Button>
            <Select<string>
              value={preset}
              onChange={setPreset}
              options={presetOptions}
              style={{ width: 140 }}
            />
            {job.groups.length > 0 && (
              <>
                <div style={pdfTemplatePickerStyle}>
                  <Text type="secondary" style={pdfTemplateLabelStyle}>Шаблон PDF</Text>
                  <Select
                    size="small"
                    value={pdfTemplateForJob}
                    onChange={setJobPdfTemplate}
                    onDropdownVisibleChange={refreshCutConfigOnPdfTemplateOpen}
                    options={pdfTemplateOptions}
                    style={{ width: 180, flex: '0 0 180px' }}
                    disabled={busy}
                    data-testid="pdf-template-select-job"
                  />
                </div>
                <Tooltip
                  title={jobPdfPreviewBlockReason ?? undefined}
                >
                  <Button
                    onClick={() => void openJobPdfPreview()}
                    loading={busy}
                    disabled={jobPdfPreviewBlockReason !== null}
                    data-testid="preview-job-pdf-btn"
                  >
                    Предпросмотр PDF (весь раскрой)
                  </Button>
                </Tooltip>
              </>
            )}
          </div>
            </section>
          </div>
        </Card>
      )}

      {job && (
        <Collapse className="cut-page-modern__details" size="small" defaultActiveKey={[]}>
          <Panel header={`Детали задания (${job.items.length})`} key="cut-job-details">
            <TableTopScroll>
              <Table<CutJobItemDto>
                className="cut-job-details-table details-grouped"
                size="small"
                rowKey="cutJobItemId"
                columns={jobItemColumns}
                dataSource={job.items}
                pagination={false}
                scroll={{ x: 1900, y: CUT_JOB_DETAILS_TABLE_BODY_HEIGHT }}
                rowClassName={(row) =>
                  orderDeletedReferenceClassName(
                    row.orderDeleted,
                    `detail-group-tint-${jobItemOrderTintByOrderId.get(row.orderId) ?? 0}`,
                  )
                }
                locale={{ emptyText: 'В задании пока нет деталей — добавьте их из заказа или через «Загрузить подходящие детали»' }}
              />
            </TableTopScroll>
          </Panel>
        </Collapse>
      )}

      {!isCreationPreview && noSheetMsg && <Alert type="warning" showIcon message={noSheetMsg} />}

      {eligible && !isCreationPreview && (
        <Card
          className="cut-page-modern__eligible"
          size="small"
          title={`Подходящие детали (${eligible.length})`}
          extra={(
            <Space size="small">
              <Text type="secondary">Выбрано: {selected.length}</Text>
              <Button size="small" type="primary" onClick={addToBasket} disabled={!canManage || selected.length === 0 || isArchivedJob} loading={busy}>
                Добавить выбранные
              </Button>
              <Button size="small" icon={<CloseOutlined />} onClick={closeEligibleDetails} disabled={busy}>
                Закрыть
              </Button>
            </Space>
          )}
        >
          <Table<EligibleDetailDto>
            size="small"
            rowKey="orderDetailId"
            columns={eligibleColumns}
            dataSource={eligible}
            pagination={false}
            scroll={{ x: eligibleTableScrollX }}
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected(keys.map(Number)),
              getCheckboxProps: (row) => ({ disabled: !row.eligible }),
            }}
          />
        </Card>
      )}

      {job && job.groups.length > 0 && (
        <Space size={12} wrap className="cut-sheet-view-controls">
          <Radio.Group
            className="cut-sheet-icon-radio"
            value={sheetPortrait}
            onChange={(event) => toggleSheetPortrait(event.target.value as boolean)}
            buttonStyle="solid"
            aria-label="Ориентация листа"
          >
            <Tooltip title="Книжная ориентация">
              <Radio.Button value={true} aria-label="Книжная ориентация">
                <SheetOrientationIcon portrait />
              </Radio.Button>
            </Tooltip>
            <Tooltip title="Альбомная ориентация">
              <Radio.Button value={false} aria-label="Альбомная ориентация">
                <SheetOrientationIcon portrait={false} />
              </Radio.Button>
            </Tooltip>
          </Radio.Group>
          <Radio.Group
            className="cut-sheet-icon-radio"
            value={sheetAxisOrigin}
            onChange={(event) => changeSheetAxisOrigin(event.target.value as CutAxisOrigin)}
            buttonStyle="solid"
            aria-label="Точка отсчёта"
          >
            <Tooltip title="Точка отсчёта слева снизу">
              <Radio.Button value="bottom-left" aria-label="Точка отсчёта слева снизу">
                <SheetOriginIcon axisOrigin="bottom-left" />
              </Radio.Button>
            </Tooltip>
            <Tooltip title="Точка отсчёта слева сверху">
              <Radio.Button value="top-left" aria-label="Точка отсчёта слева сверху">
                <SheetOriginIcon axisOrigin="top-left" />
              </Radio.Button>
            </Tooltip>
          </Radio.Group>
        </Space>
      )}

      {job?.groups.map((group) => {
        // Readable group title: «Раскрой: <материал> · N листов» (fallback to id).
        const sheetOption = sheetOptions.find((o) => o.sheetMaterialTypeId === group.sheetMaterialTypeId);
        const matName = sheetOption?.name;
        const showBathMeterGuides = shouldShowBathMeterGuides({
          engineUsed: group.summary?.engine_used,
          layoutMode: profiles.find((profile) => profile.cutParamProfileId === job.paramProfileId)?.params?.layout_mode,
          materialName: sheetOption?.name,
          materialWidthMm: sheetOption?.widthMm,
          materialHeightMm: sheetOption?.heightMm,
        });
        const filmNames = groupFilmNames(job, group);
        const filmText = filmNames.length > 0 ? filmNames.join(', ') : null;
        const filmLabel = filmNames.length > 1 ? 'Плёнки' : 'Плёнка';
        const title = matName
          ? `Раскрой: ${matName} · ${group.sheets.length} л.`
          : `Группа #${group.cutGroupId}`;

        // ── Per-group manual-layout state ───────────────────────────────────
        // Current toggle value (operator choice, not yet persisted).
        const showAlt = showAlternativeByGroup[group.cutGroupId] ?? false;
        // effectiveManual: which variant the preview/print actually shows.
        // isActive drives PRINT; isStale means the pieces drifted (recalc needed).
        const effectiveManual = !!(group.manualLayout?.isActive && !group.manualLayout?.isStale);
        // Render token for request URL/state discrimination (absent on groups without a manual layout).
        const renderVersion = group.renderToken;
        // Stale: the manual layout pieces may not match the current auto set.
        // (Declared before displayVariant below, which reads it.)
        const isStale = group.manualLayout?.isStale ?? false;
        const historicalManualAvailable = isHistoricalResult && group.manualLayout != null;
        // Variant to pass to PNG/SVG fetch so the preview matches the toggle.
        // Guard: when the manual layout is stale, never pass variant=manual — the backend
        // hard-fails such requests with 409 CUT_MANUAL_LAYOUT_UNAVAILABLE. Fall back to 'auto'.
        const displayVariant: 'auto' | 'manual' | 'active' = showAlt && (!isStale || historicalManualAvailable) ? 'manual' : 'auto';
        // Is this group currently open in the editor?
        const isEditingGroup = editingGroupId === group.cutGroupId;
        // Persisted active flag (what the backend currently has).
        const persistedActive = group.manualLayout?.isActive ?? false;
        // Group is dirty when: in edit mode OR toggle differs from persisted isActive.
        const isDirtyGroup =
          isEditingGroup ||
          (group.manualLayout != null && showAlt !== persistedActive);
        const groupPdfPreviewBlockReason = cutPdfPreviewBlockReason({
          isFrozenResult: isHistoricalResult,
          hasUnsavedChanges: isDirtyGroup,
          requiresRecalc: job.requiresRecalc ?? false,
        });
        const showStaleBadge = shouldShowCutStaleBadge({
          isFrozenResult: isHistoricalResult,
          requiresRecalc: job.requiresRecalc ?? false,
          manualLayoutIsStale: isStale,
          manualLayoutIsActive: persistedActive,
        });
        // Edit is blocked when editorParams are absent or a recalc is required.
        const legacyAutoLayoutInvalid = job.autoLayoutValidation?.valid === false;
        // Preview sheets: honour displayVariant so count/overlays follow the
        // manual layout when the operator has switched to the manual view.
        const previewSheets = selectVariantSheets(group, displayVariant);
        const groupInvariantError = validateSheetGroupInvariant(previewSheets);
        const editableInvariantError = validateSheetGroupInvariant(editableSheetsForGroup(group));
        const editDisabled = !(job.editorParams) || (job.requiresRecalc ?? false) || legacyAutoLayoutInvalid || Boolean(editableInvariantError);

        return (
          <Card
            className="cut-page-modern__group"
            key={group.cutGroupId}
            id={`cut-group-card-${group.cutGroupId}`}
            size="small"
            // scrollMarginTop keeps the card title visible under the sticky
            // header when the back-to-top button scrolls the card into view.
            style={{ scrollMarginTop: stickyHeaderTop }}
            // Sticky group header: keeps the group name, «устарел» badge,
            // «Редактировать раскрой» and «Скачать PDF» on screen while the
            // operator scrolls through a tall group with many sheets.
            headStyle={{
              position: 'sticky',
              top: stickyHeaderTop,
              zIndex: 5,
              background: token.colorBgContainer,
            }}
            title={
              <Space size="small">
                {title}
                {/* «устарел» badge: the auto layout needs a recalc, OR the ACTIVE
                    manual layout has drifted stale. An INACTIVE stale manual (not
                    shown/printed) must NOT flag the group — otherwise «Рассчитать»
                    can never clear the badge while a dangling old manual exists. */}
                {showStaleBadge && (
                  <Tag color="warning">устарел</Tag>
                )}
                {effectiveManual && !isStale && (
                  <Tag color="blue">ручной раскрой активен</Tag>
                )}
              </Space>
            }
            extra={
              <div style={cutActionToolbarStyle}>
                {isEditingGroup && (
                  <Space size={4} data-testid="sticky-editor-zoom-controls">
                    <Tooltip
                      title={
                        editorHistory.length > 0
                          ? `Отменить последнее перемещение или поворот детали (доступно шагов: ${editorHistory.length})`
                          : 'Нет шагов для отмены'
                      }
                    >
                      <Button
                        aria-label="Отменить последний шаг редактирования"
                        icon={<UndoOutlined />}
                        style={{ height: 40 }}
                        onClick={undoEditorStep}
                        disabled={busy || editorHistory.length === 0}
                        data-testid="undo-edit-step-btn"
                      >
                        Отменить шаг
                      </Button>
                    </Tooltip>
                    <Tooltip title="Уменьшить масштаб группы раскроя">
                      <Button
                        aria-label="Уменьшить масштаб группы раскроя"
                        icon={<MinusOutlined />}
                        style={{ width: 40, height: 40 }}
                        disabled={editorViewZoom <= MIN_EDITOR_VIEW_ZOOM}
                        onClick={() => setEditorViewZoom((value) => Math.max(MIN_EDITOR_VIEW_ZOOM, value - EDITOR_VIEW_ZOOM_STEP))}
                      />
                    </Tooltip>
                    <span
                      data-testid="sheet-editor-zoom-value"
                      style={{ minWidth: 52, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {Math.round(editorViewZoom * 100)}%
                    </span>
                    <Tooltip title="Увеличить масштаб группы раскроя">
                      <Button
                        aria-label="Увеличить масштаб группы раскроя"
                        icon={<PlusOutlined />}
                        style={{ width: 40, height: 40 }}
                        disabled={editorViewZoom >= MAX_EDITOR_VIEW_ZOOM}
                        onClick={() => setEditorViewZoom((value) => Math.min(MAX_EDITOR_VIEW_ZOOM, value + EDITOR_VIEW_ZOOM_STEP))}
                      />
                    </Tooltip>
                  </Space>
                )}
                {/* «Показать альтернативный раскрой» — only shown when a manual layout exists.
                    Disabled (with tooltip) when the layout is stale: variant=manual would 409. */}
                {group.manualLayout && (
                  <Tooltip title={isStale && !isHistoricalResult ? 'Ручной раскрой устарел — пересчитайте' : undefined}>
                    <Checkbox
                      checked={showAlt}
                      onChange={(e) =>
                        setShowAlternativeByGroup((prev) => ({
                          ...prev,
                          [group.cutGroupId]: e.target.checked,
                        }))
                      }
                      disabled={isEditingGroup || (isStale && !isHistoricalResult)}
                      data-testid={`show-alternative-cb-${group.cutGroupId}`}
                    >
                      Показать альтернативный раскрой
                    </Checkbox>
                  </Tooltip>
                )}
                {/* «Редактировать раскрой» — full-scale group view only; disabled on requiresRecalc */}
                {canManage && !isArchivedJob && (
                  <Tooltip
                    title={
                      legacyAutoLayoutInvalid
                        ? 'Раскрой содержит некорректные зазоры — требуется пересчёт'
                        : (job.requiresRecalc ?? false)
                        ? 'Требуется пересчёт'
                        : !(job.editorParams)
                        ? 'Редактор недоступен'
                        : undefined
                    }
                  >
                    <Button
                      className="app-hit-area-sm"
                      size="small"
                      onClick={() => enterEditMode(group)}
                      disabled={editDisabled || busy || isEditingGroup}
                      data-testid={`edit-layout-btn-${group.cutGroupId}`}
                    >
                      Редактировать раскрой
                    </Button>
                  </Tooltip>
                )}
                {/* «Скачать PDF» — disabled while dirty or requiresRecalc */}
                <div style={pdfTemplatePickerStyle}>
                  <Text type="secondary" style={pdfTemplateLabelStyle}>Шаблон PDF</Text>
                  <Select
                    size="small"
                    value={pdfTemplateByGroup[group.cutGroupId] ?? group.pdfTemplate ?? 'standard'}
                    onChange={(value) => setGroupPdfTemplate(group, value)}
                    onDropdownVisibleChange={refreshCutConfigOnPdfTemplateOpen}
                    options={pdfTemplateOptions}
                    style={{ width: 180, flex: '0 0 180px' }}
                    disabled={busy}
                    data-testid={`pdf-template-select-${group.cutGroupId}`}
                  />
                </div>
                <Tooltip
                  title={groupPdfPreviewBlockReason ?? undefined}
                >
                  <Button
                    className="app-hit-area-sm"
                    size="small"
                    onClick={() => void openGroupPdfPreview(group)}
                    loading={busy}
                    disabled={groupPdfPreviewBlockReason !== null}
                    data-testid={`preview-group-pdf-btn-${group.cutGroupId}`}
                  >
                    Предпросмотр PDF
                  </Button>
                </Tooltip>
              </div>
            }
          >
            <Text type="secondary">{formatGroupSummary(group.summary)}</Text>
            {(groupInvariantError || editableInvariantError) && (
              <Alert type="error" showIcon message="Повреждённая раскладка: несовместимые листы в группе" />
            )}
            <div style={{ marginTop: 4, color: '#595959', fontSize: 13 }}>
              Материал раскроя: <b>{matName ?? 'не задан'}</b>
              {filmText && (
                <>
                  {' '}· {filmLabel}: <b>{filmText}</b>
                </>
              )}
            </div>

            {/* ── Editor mode ────────────────────────────────────────────────── */}
            {isEditingGroup && job.editorParams && !groupInvariantError && (
              <div style={{ marginTop: 12 }}>
                <Space style={{ marginBottom: 8 }}>
                  <Tooltip title={violations.length > 0 ? `${violations.length} нарушений геометрии` : undefined}>
                    <Button
                      type="primary"
                      size="small"
                      disabled={violations.length > 0 || (job.requiresRecalc ?? false) || legacyAutoLayoutInvalid || busy}
                      onClick={() => void saveManualLayoutForGroup(group)}
                      loading={busy}
                      data-testid="save-manual-layout-btn"
                    >
                      Сохранить изменения
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingGroupId(null);
                      setWorkingSheets([]);
                      setViolations([]);
                      setEditorHistory([]);
                    }}
                    disabled={busy}
                    data-testid="cancel-edit-btn"
                  >
                    Отменить редактирование
                  </Button>
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={addEditorSheet}
                    disabled={busy || workingSheets.length === 0}
                    data-testid="add-manual-sheet-btn"
                  >
                    Добавить лист
                  </Button>
                  {violations.length > 0 && (
                    <Text type="danger">{violations.length} нарушений геометрии — исправьте перед сохранением</Text>
                  )}
                </Space>
                <SheetEditor
                  sheets={workingSheets}
                  viewZoom={editorViewZoom}
                  sheetRotations={editorSheetRotations}
                  sheetMirrors={editorSheetMirrors}
                  onSheetRotationChange={(sheetIndex, rotationDeg) => setEditorSheetRotations((current) => ({ ...current, [sheetIndex]: rotationDeg }))}
                  onSheetMirrorChange={(sheetIndex, mirror) => setEditorSheetMirrors((current) => ({ ...current, [sheetIndex]: mirror }))}
                  gap={{ kerfMm: job.editorParams.kerfMm, spacingMm: job.editorParams.spacingMm }}
                  filmTextureByItemId={editorFilmTextureByItemId}
                  labelInfoByItemId={editorLabelInfoByItemId}
                  // Match the preview orientation EXACTLY: the preview rotates each
                  // sheet via sheetPreviewRotate90(dims, sheetPortrait) (per-sheet,
                  // dimension-aware), but the editor previously got a raw `!sheetPortrait`
                  // that ignored the sheet's actual w/h — so a landscape sheet opened
                  // portrait. All sheets in a group share dimensions, so derive the
                  // rotate flag from the group's representative (first) working sheet.
                  landscape={(() => {
                    const p = workingSheets[0]?.placements;
                    return p
                      ? sheetPreviewRotate90(p.sheet_width_mm, p.sheet_height_mm, sheetPortrait)
                      : !sheetPortrait;
                  })()}
                  originTopLeft={effectiveSheetOrigin(workingSheets[0]?.placements, sheetOriginTopLeft, sheetAxisOrigin)}
                  axisOrigin={sheetAxisOrigin}
                  onChange={handleEditorChange}
                  onRemoveSheet={removeEditorSheet}
                  violations={violations}
                  splitByMaterial={job.splitByMaterial}
                  combineFilms={job.combineFilms}
                  groupMaterialTypeId={editingGroup?.sheetMaterialTypeId ?? null}
                  groupFilmId={editingGroup?.filmId ?? null}
                  pieceMetaByItemId={pieceMetaByItemId}
                  pieceSheetInfoByItemId={pieceSheetInfoByItemId}
                  showFilm={!job.combineFilms}
                  showBathMeterGuides={showBathMeterGuides}
                />
              </div>
            )}

            {/* ── Normal sheet previews (hidden while in editor mode) ─────────── */}
            {!isEditingGroup && (
              /* Previews flow in wrapping rows (not a single column). */
              <div style={sheetPreviewListStyle}>
                {previewSheets.map((sheet, sheetPos) => {
                  // Display number is the DENSE position (1..N): the manual layout may
                  // omit an emptied sheet, leaving a gap in the real sheet_index. Real
                  // sheet.sheetIndex is still used for cache keys, fetch and labels.
                  const sheetNo = sheetPos + 1;
                  // Client cache key = group:sheet:variant:orientation:origin (NO
                  // renderVersion) — must match loadSheet/loadThumb. resetSheetViews()
                  // busts on layout change; orientation AND origin are in the key (a job
                  // switch may rehydrate a different saved orientation/origin); renderVersion
                  // stays only in the fetch (server bust). Keeps the cached preview stable
                  // across no-recalc version bumps.
                  const key = `${group.cutGroupId}:${sheet.sheetIndex}:${displayVariant}:${sheetPortrait ? 'P' : 'L'}:${sheetOriginTopLeft ? 'tl' : 'raw'}:${sheetAxisOrigin}`;
                  // Stable React element identity per (group, sheet) — deliberately NOT
                  // the cache key. A renderVersion bump (e.g. changing profile/material,
                  // which only marks the job stale) then refreshes the image in place
                  // instead of unmounting/remounting the whole preview row, which used to
                  // collapse the list and bounce the page scroll down-then-back.
                  const elemKey = `${group.cutGroupId}:${sheet.sheetIndex}`;
                  const widthMm = sheet.placements.sheet_width_mm;
                  const heightMm = sheet.placements.sheet_height_mm;
                  const rotate90 = sheetPreviewRotate90(widthMm, heightMm, sheetPortrait);
                  const originTopLeft = effectiveSheetOrigin(sheet.placements, sheetOriginTopLeft, sheetAxisOrigin);
                  const displayWidthMm = rotate90 ? heightMm : widthMm;
                  const displayHeightMm = rotate90 ? widthMm : heightMm;
                  const isPortraitPreview = displayHeightMm > displayWidthMm;
                  const overlays = buildSheetPieceOverlays(sheet.placements, job.items, rotate90, originTopLeft, sheetAxisOrigin);
                  const sheetDetailInstances = detailInstancesForSheet(sheet);
                  const bathFilmUsage = showBathMeterGuides ? calculateBathSheetFilmUsage(sheet.placements) : null;
                  return (
                    <div
                      key={elemKey}
                      style={
                        // Open (enlarged) sheet spans the full previews row so the
                        // image can grow ~2× instead of being capped by the thumbnail
                        // column width.
                        sheetImages[key]
                          ? { flex: '1 1 100%', maxWidth: '100%' }
                          : sheetPreviewItemStyle(widthMm, heightMm, rotate90)
                      }
                    >
                      <div className={`cut-sheet-preview-header${isPortraitPreview ? ' cut-sheet-preview-header--portrait' : ''}`}>
                        <div className="cut-sheet-preview-title app-tabular">
                          {isPortraitPreview ? (
                            <>
                              <strong>Лист {sheetNo}</strong>
                              <span>{matName ?? 'материал не задан'}</span>
                              {filmText && <span>{filmLabel}: {filmText}</span>}
                              <span>кол-во деталей - {sheet.placements.pieces.length}</span>
                              {bathFilmUsage && (
                                <span>Потребность плёнки: <b>{formatFilmLinearMeters(bathFilmUsage.linearMeters)}</b></span>
                              )}
                            </>
                          ) : (
                            <>
                              <strong>Лист {sheetNo}</strong>
                              {' · '}
                              {matName ?? 'материал не задан'}
                              {filmText ? ` · ${filmLabel}: ${filmText}` : ''}
                              {' · '}
                              кол-во деталей - {sheet.placements.pieces.length}
                              {bathFilmUsage && (
                                <>
                                  {' · '}
                                  <span>Потребность плёнки: <b>{formatFilmLinearMeters(bathFilmUsage.linearMeters)}</b></span>
                                </>
                              )}
                            </>
                          )}
                        </div>
                        <Space className="cut-sheet-preview-actions" size={8}>
                          <Button
                            className="app-hit-area-sm"
                            size="small"
                            onClick={() =>
                              sheetImages[key]
                                ? collapseSheet(key)
                                : loadSheet(group, sheet.sheetIndex, displayVariant, renderVersion)
                            }
                          >
                            {sheetImages[key] ? 'Свернуть' : 'Развернуть'}
                          </Button>
                          <Button
                            className="app-hit-area-sm"
                            size="small"
                            onClick={() => downloadSheetSvg(group, sheet.sheetIndex, displayVariant, renderVersion, sheetNo)}
                          >
                            SVG
                          </Button>
                          <CutSheetLabelGenerateAction
                            detailInstances={sheetDetailInstances}
                            cutJobId={job.cutJobId}
                            cutGroupId={group.cutGroupId}
                            sheetIndex={sheet.sheetIndex}
                          />
                        </Space>
                      </div>
                      {sheetThumbs[key] && !sheetImages[key] && (
                        <SheetPreview
                          src={sheetThumbs[key]}
                          alt={`Превью листа ${sheetNo}`}
                          widthMm={widthMm}
                          heightMm={heightMm}
                          landscape={rotate90}
                          full={false}
                          overlays={overlays}
                          onOpen={() => loadSheet(group, sheet.sheetIndex, displayVariant, renderVersion)}
                        />
                      )}
                      {sheetImages[key] && (
                        <SheetPreview
                          src={sheetImages[key]}
                          alt={`Лист ${sheetNo}`}
                          widthMm={widthMm}
                          heightMm={heightMm}
                          landscape={rotate90}
                          full
                          overlays={overlays}
                          onCollapse={() => collapseSheet(key)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
      </Space>
      {job && showBackToTop && (
        <div style={backToTopFixedStyle}>
          <Button icon={<UpOutlined />} onClick={scrollBackToGroupTop} data-testid="back-to-top-btn">
            Наверх
          </Button>
        </div>
      )}
      <Modal
        title={pdfPreview.title}
        open={pdfPreview.open}
        onCancel={closeGroupPdfPreview}
        width={1040}
        destroyOnHidden
        footer={[
          <Button key="close" onClick={closeGroupPdfPreview}>
            Закрыть
          </Button>,
          <Button key="download" disabled={!pdfPreview.blob || pdfPreview.loading} onClick={downloadPreviewPdf}>
            Скачать
          </Button>,
          <Button
            key="print"
            type="primary"
            icon={<PrinterOutlined />}
            disabled={!pdfPreview.blob || pdfPreview.loading}
            onClick={printPreviewPdf}
            data-testid="print-preview-pdf-btn"
          >
            Печать
          </Button>,
        ]}
      >
        <div style={{ minHeight: 420 }}>
          <CutPdfPreview blob={pdfPreview.blob} loading={pdfPreview.loading} />
        </div>
      </Modal>
      <CutSvgUploadModal
        open={svgUploadOpen}
        onClose={() => setSvgUploadOpen(false)}
        onDone={(cutJobId) => {
          void loadJobs(listFiltersRef.current);
          if (cutJobId) void openJob(cutJobId);
        }}
      />
    </>
  );
};
