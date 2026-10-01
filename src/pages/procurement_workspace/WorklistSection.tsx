import { DeleteOutlined, HistoryOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Button, DatePicker, Empty, Input, Modal, Select, Space, Tag, message } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useGetIdentity } from '@refinedev/core';
import { Link, useSearchParams } from 'react-router-dom';
import { ordersApi, subscribeOrderDataChanged } from '../../api/ordersApi';
import { procurementWorkspaceApi } from '../../api/procurementWorkspaceApi';
import type {
  ProcurementSavedView,
  ProcurementWorklistLine,
  ProcurementWorklistResponse,
  WorklistGroupBy,
  WorklistPreset,
} from '../../api/types/procurementWorkspaceApi.types';
import type { UserIdentity } from '../../types/auth';
import { HistoryDrawer, type HistoryDrawerLine } from './HistoryDrawer';
import { Segmented } from '../../ui/Segmented';
import { Table, Tooltip, type TableProps } from '../../ui/tooltipDelay';
import { useProcurementPermission } from '../order_resource_requirements/ProcurementParts';
import {
  buildOnecDocumentFilterOptionGroups,
  type OnecDocumentFilterDoc,
} from '../order_resource_requirements/onecDocumentFilter';
import { buildDraftPreviewItems, requestRefTag, saveDraftPreview } from './supplierRequestsHelpers';
import {
  COVERAGE_LABELS,
  coveragePercents,
  dueText,
  formatDate,
  formatQuantity,
  applySelectionChange,
  bulkMarkBlockReason,
  clampPage,
  isGroupSelected,
  parseWorklistSearch,
  planBulkMarks,
  stateFromViewQuery,
  stateToViewQuery,
  toApiParams,
  toggleGroupSelection,
  worklistExportRows,
  writeWorklistSearch,
  type WorklistState,
} from './worklistHelpers';

const LIVE_REFRESH_MS = 30_000;
/** Цвет вида материала — как в мокапе: листовой / плёнка. */
const KIND_COLORS = { sheet_material: '#a0661c', film: '#0e8f84' } as const;
/** Тона мягких тегов мокапа. */
const COVERAGE_TONES = { covered: 'ok', partial: 'warn', ordered: 'info', none: 'bad', no_data: 'none' } as const;
const URGENCY_TONES = { overdue: 'bad', critical: 'bad', soon: 'warn', normal: 'none', no_date: 'none' } as const;
const PAGE_SIZE = 50;

export interface WorklistSectionProps {
  /** Вкладка видна: иначе без опроса сервера и горячих клавиш. */
  active: boolean;
  /** Счётчик срочных позиций — для бейджа вкладки. */
  onUrgentCount?: (count: number) => void;
  /** `capabilities` последнего ответа — чтобы родитель мог показать/скрыть вкладку «Заявки поставщикам». */
  onCapabilities?: (capabilities: ProcurementWorklistResponse['capabilities']) => void;
}

export function WorklistSection({ active, onUrgentCount, onCapabilities }: WorklistSectionProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = useMemo(() => parseWorklistSearch(searchParams), [searchParams]);
  const setState = useCallback((patch: Partial<WorklistState>) => {
    setSearchParams((current) => writeWorklistSearch(current, { ...parseWorklistSearch(current), ...patch }), { replace: true });
  }, [setSearchParams]);

  const [searchInput, setSearchInput] = useState(state.search);
  useEffect(() => { setSearchInput(state.search); }, [state.search]);
  useEffect(() => {
    if (searchInput === state.search) return undefined;
    const timer = window.setTimeout(() => setState({ search: searchInput }), 400);
    return () => window.clearTimeout(timer);
  }, [searchInput, setState, state.search]);

  const [response, setResponse] = useState<ProcurementWorklistResponse | null>(null);
  /** Под какие фильтры загружен `response`: при расхождении выделение и действия недоступны (CR1-3). */
  const [responseKey, setResponseKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const sequence = useRef(0);
  const paramsKey = JSON.stringify(toApiParams(state));

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const load = async (silent: boolean) => {
      const id = ++sequence.current;
      if (!silent) setLoading(true);
      try {
        const next = await procurementWorkspaceApi.worklist(JSON.parse(paramsKey));
        if (!alive || id !== sequence.current) return;
        setResponse(next);
        setResponseKey(paramsKey);
        setError(null);
      } catch (loadError) {
        if (!alive || id !== sequence.current) return;
        setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить рабочий список');
      } finally {
        if (alive && id === sequence.current) setLoading(false);
      }
    };
    void load(false);
    const interval = window.setInterval(() => void load(true), LIVE_REFRESH_MS);
    const unsubscribe = subscribeOrderDataChanged(() => void load(true));
    return () => { alive = false; window.clearInterval(interval); unsubscribe(); };
  }, [active, paramsKey, revision]);

  useEffect(() => { if (response) onUrgentCount?.(response.counts.urgent); }, [onUrgentCount, response]);
  useEffect(() => { if (response) onCapabilities?.(response.capabilities); }, [onCapabilities, response]);

  const stale = loading || responseKey !== paramsKey || error !== null;
  const staleRef = useRef(stale);
  staleRef.current = stale;
  const lines = useMemo(() => response?.lines ?? [], [response]);
  const lineByKey = useMemo(() => new Map(lines.map((line) => [line.lineKey, line])), [lines]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  // Выделение — только среди видимых строк: после смены фильтров исчезнувшие снимаются.
  useEffect(() => {
    setSelected((current) => {
      const next = new Set([...current].filter((key) => lineByKey.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [lineByKey]);
  const selectedLines = useMemo(() => [...selected].map((key) => lineByKey.get(key)).filter(Boolean) as ProcurementWorklistLine[], [lineByKey, selected]);

  const suppliersSeen = useRef(new Map<string, string>());
  for (const line of lines) suppliersSeen.current.set(line.supplier.key, line.supplier.name);
  const supplierOptions = [...suppliersSeen.current.entries()]
    .sort(([, left], [, right]) => left.localeCompare(right, 'ru'))
    .map(([value, label]) => ({ value, label }));

  // Варианты фильтра «Документ 1С»: документы, распределённые на заказы в scope пользователя.
  const [onecDocs, setOnecDocs] = useState<OnecDocumentFilterDoc[]>([]);
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    ordersApi.listResourceDemandOnecDocuments({})
      .then((response) => { if (alive) setOnecDocs(response.data as OnecDocumentFilterDoc[]); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [active]);

  const { canManage, manageLoading } = useProcurementPermission();
  const [marking, setMarking] = useState(false);
  const plan = useMemo(() => planBulkMarks(selectedLines), [selectedLines]);
  const markBlockReason = bulkMarkBlockReason({ stale, canManage, manageLoading, plan });
  const markPurchased = useCallback(async () => {
    if (markBlockReason) { message.info(markBlockReason); return; }
    const confirmed = await new Promise<boolean>((resolve) => {
      Modal.confirm({
        title: 'Отметить «Закуплено»',
        content: plan.requests.length > 1
          ? `${plan.requests.length} материала — ${plan.requests.length} отдельные операции: каждая выполняется целиком, но независимо от других.`
          : `Материал «${plan.requests[0].materialName}»: ${plan.requests[0].items.length} заказ(ов).`,
        okText: 'Отметить',
        cancelText: 'Отмена',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
    // Пока шло подтверждение, фильтры могли смениться — выделение тогда относится к старому списку.
    if (!confirmed || staleRef.current) return;
    setMarking(true);
    const failures: string[] = [];
    let done = 0;
    for (const request of plan.requests) {
      const { materialName, ...body } = request;
      try {
        await ordersApi.bulkSetResourceProcurement(body);
        done += 1;
      } catch (markError) {
        failures.push(`${materialName}: ${markError instanceof Error ? markError.message : 'ошибка'}`);
      }
    }
    setMarking(false);
    if (failures.length === 0) message.success(`Отмечено материалов: ${done}`);
    else Modal.warning({ title: `Отмечено ${done} из ${plan.requests.length}`, content: failures.join('\n') });
    refresh();
  }, [markBlockReason, plan, refresh]);

  // «Сформировать заявки» (план §6): превью выделения — в sessionStorage, переход на раздел «requests».
  const { data: identity } = useGetIdentity<UserIdentity>();
  const identityId = identity?.id === undefined || identity?.id === null ? null : String(identity.id);
  const formRequests = useCallback(() => {
    const items = buildDraftPreviewItems(selectedLines);
    if (items.length === 0) { message.info('У выбранных позиций нет непокрытого дефицита — заказывать нечего'); return; }
    if (identityId === null) { message.info('Профиль ещё загружается — повторите через секунду'); return; }
    saveDraftPreview(identityId, items);
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set('section', 'requests');
      return params;
    }, { replace: true });
  }, [identityId, selectedLines, setSearchParams]);

  const exportExcel = useCallback(async () => {
    if (staleRef.current) return;
    const XLSX = await import('xlsx');
    const rows = worklistExportRows(selectedLines.length > 0 ? selectedLines : lines);
    const sheet = XLSX.utils.json_to_sheet(rows);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Снабжение');
    XLSX.writeFile(book, `снабжение-${response?.today ?? dayjs().format('YYYY-MM-DD')}.xlsx`);
  }, [lines, response?.today, selectedLines]);

  // Горячие клавиши: j/k — строка, x — выделить, Esc — снять выделение. Фокус — только по видимым строкам
  // в порядке показа: текущая страница без группировки или группы целиком (CR2-4).
  const [requestedPage, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [paramsKey]);
  // Список мог сократиться (например, после отметки) — страница та же, что показывает таблица (CR3-2).
  const page = clampPage(requestedPage, lines.length, PAGE_SIZE);
  const displayKeys = useMemo(() => (state.groupBy === 'none' || !response
    ? lines.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((line) => line.lineKey)
    : response.groups.flatMap((group) => group.lineKeys)), [lines, page, response, state.groupBy]);
  const [focusIndex, setFocusIndex] = useState(-1);
  useEffect(() => { setFocusIndex(-1); }, [displayKeys]);
  useEffect(() => {
    if (!active) return undefined;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'j') setFocusIndex((index) => Math.min(displayKeys.length - 1, index + 1));
      else if (event.key === 'k') setFocusIndex((index) => Math.max(0, index - 1));
      else if (event.key === 'x' && displayKeys[focusIndex] && !staleRef.current) {
        const key = displayKeys[focusIndex];
        setSelected((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
      } else if (event.key === 'Escape') setSelected(new Set());
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, displayKeys, focusIndex]);
  const focusedKey = displayKeys[focusIndex] ?? null;

  // «История» (этап 4a): отдельная строка открывает Drawer; смена строки до закрытия — новый экземпляр (key).
  const [historyLine, setHistoryLine] = useState<HistoryDrawerLine | null>(null);
  const openHistory = useCallback((line: ProcurementWorklistLine) => {
    setHistoryLine({ orderId: line.orderId, resourceKey: line.resourceKey, name: line.name, fullNumber: line.fullNumber });
  }, []);

  const columns = useWorklistColumns(response?.today ?? null, openHistory);
  // Изменения выделения приходят порциями (строка, страница, диапазон Shift) — применяем только их,
  // строки других групп/страниц сохраняются (CR1-6). Пока список не совпадает с фильтрами — выделять нельзя.
  const rowSelection: TableProps<ProcurementWorklistLine>['rowSelection'] = {
    selectedRowKeys: [...selected],
    getCheckboxProps: () => ({ disabled: stale }),
    onSelect: (record, isSelected) => setSelected((current) => applySelectionChange(current, [record.lineKey], isSelected)),
    onSelectAll: (isSelected, _rows, changeRows) =>
      setSelected((current) => applySelectionChange(current, changeRows.map((row) => row.lineKey), isSelected)),
    onSelectMultiple: (isSelected, _rows, changeRows) =>
      setSelected((current) => applySelectionChange(current, changeRows.map((row) => row.lineKey), isSelected)),
  };

  // Одна таблица, как в мокапе: при группировке строки групп встроены в неё (заголовок + «Выделить группу»).
  const tableRows: WorklistRow[] = useMemo(() => {
    if (state.groupBy === 'none' || !response) return lines;
    return response.groups.flatMap((group) => [
      { rowType: 'group' as const, lineKey: `group:${group.key}`, group },
      ...(group.lineKeys.map((key) => lineByKey.get(key)).filter(Boolean) as ProcurementWorklistLine[]),
    ]);
  }, [lineByKey, lines, response, state.groupBy]);
  const groupColumns = useMemo(() => withGroupRows(columns ?? [], (group) => {
    const whole = isGroupSelected(group.lineKeys, selected);
    return (
      <span>
        {group.label}{' '}
        <span className="rr-grp-info">
          · {group.linesCount} поз. · дефицит {[group.deficitM2 ? formatQuantity(group.deficitM2, 'm2') : '', group.deficitLm ? formatQuantity(group.deficitLm, 'lm') : ''].filter(Boolean).join(' + ') || '0'}
        </span>
        <Button size="small" style={{ marginLeft: 10 }} disabled={stale} onClick={() => setSelected((current) => toggleGroupSelection(group.lineKeys, current))}>
          {whole ? 'Снять выделение' : 'Выделить группу'}
        </Button>
      </span>
    );
  }), [columns, selected, stale]);
  const worklistSelection: TableProps<WorklistRow>['rowSelection'] = {
    ...(rowSelection as unknown as TableProps<WorklistRow>['rowSelection']),
    getCheckboxProps: (row) => ({ disabled: stale || isGroupRow(row) }),
    renderCell: (_checked, row, _index, node) => (isGroupRow(row) ? null : node),
    onSelect: (record, isSelected) => { if (!isGroupRow(record)) setSelected((current) => applySelectionChange(current, [record.lineKey], isSelected)); },
    onSelectAll: (isSelected, _rows, changeRows) =>
      setSelected((current) => applySelectionChange(current, changeRows.filter((row) => !isGroupRow(row)).map((row) => row.lineKey), isSelected)),
    onSelectMultiple: (isSelected, _rows, changeRows) =>
      setSelected((current) => applySelectionChange(current, changeRows.filter((row) => !isGroupRow(row)).map((row) => row.lineKey), isSelected)),
  };

  const selectionDeficit = summarizeDeficit(selectedLines);
  const selectedSuppliers = new Set(selectedLines.map((line) => line.supplier.key)).size;
  const counts = response?.counts;

  return (
    <div style={{ paddingBottom: selected.size > 0 ? 72 : 0 }}>
      <div className="rr-appbar">
        <span className="rr-ttl">Рабочий список</span>
        <span className="rr-muted">что закупить и к какому сроку</span>
      </div>
      <div className="rr-toolbar">
        <Segmented
          aria-label="Набор"
          value={state.preset}
          onChange={(value) => setState({ preset: value as WorklistPreset })}
          options={[
            { value: 'action', label: <span>Требует действия<span className="rr-badge">{counts?.action ?? 0}</span></span> },
            { value: 'urgent', label: <span>Срочно на этой неделе<span className="rr-badge rr-badge--bad">{counts?.urgent ?? 0}</span></span> },
            { value: 'all', label: <span>Всё<span className="rr-badge">{counts?.all ?? 0}</span></span> },
          ]}
        />
        <Segmented
          aria-label="Группировка"
          value={state.groupBy}
          onChange={(value) => setState({ groupBy: value as WorklistGroupBy })}
          options={[
            { value: 'none', label: 'Без группировки' },
            { value: 'supplier', label: 'По поставщикам' },
            { value: 'material', label: 'По материалам' },
          ]}
        />
        <Input
          allowClear
          placeholder="Заказ, клиент, материал"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ width: 200 }}
        />
        <DatePicker.RangePicker
          format="DD.MM.YYYY"
          placeholder={['Нужно к: с', 'по']}
          style={{ width: 230 }}
          value={state.dueFrom || state.dueTo ? [state.dueFrom ? dayjs(state.dueFrom) : null, state.dueTo ? dayjs(state.dueTo) : null] : null}
          onChange={(range) => setState({
            dueFrom: range?.[0] ? range[0].format('YYYY-MM-DD') : null,
            dueTo: range?.[1] ? range[1].format('YYYY-MM-DD') : null,
          })}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Документ 1С"
          style={{ width: 170 }}
          dropdownMatchSelectWidth={320}
          value={state.onecDocumentId ?? undefined}
          onChange={(value) => setState({ onecDocumentId: value ?? null })}
          options={buildOnecDocumentFilterOptionGroups(onecDocs)}
          notFoundContent="Нет распределённых документов"
        />
        <Select
          allowClear
          placeholder="Вид"
          style={{ width: 120 }}
          value={state.kind ?? undefined}
          onChange={(value) => setState({ kind: value ?? null })}
          options={[{ value: 'sheet_material', label: 'Листовые' }, { value: 'film', label: 'Плёнка' }]}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Поставщик"
          style={{ width: 170 }}
          value={state.supplierKey ?? undefined}
          onChange={(value) => setState({ supplierKey: value ?? null })}
          options={supplierOptions}
        />
        <Select
          mode="multiple"
          allowClear
          maxTagCount="responsive"
          placeholder="Покрытие"
          style={{ minWidth: 150 }}
          value={state.coverage}
          onChange={(value) => setState({ coverage: value })}
          options={Object.entries(COVERAGE_LABELS).map(([value, { label }]) => ({ value, label }))}
        />
        <SavedViews state={state} onApply={(next) => setState(next)} active={active} />
        <Tooltip title="Обновить">
          <Button icon={<ReloadOutlined />} onClick={refresh} aria-label="Обновить" />
        </Tooltip>
      </div>

      <div className="rr-pad rr-pad--top">
        {state.onecDocumentId !== null && (
          <span>
            <Tag closable onClose={() => setState({ onecDocumentId: null })}>Только позиции документа 1С #{state.onecDocumentId}</Tag>
          </span>
        )}
        {error && <Alert type="error" showIcon message={error} />}
        <div className="rr-summary">
          <div className="rr-kpi"><div className="rr-kpi-l">Не покрыто позиций</div><div className="rr-kpi-v">{formatInteger(response?.totals.uncovered ?? 0)}</div></div>
          <div className="rr-kpi">
            <div className="rr-kpi-l">Срочно (≤ {response?.settings.soonDays ?? 7} дней)</div>
            <div className={`rr-kpi-v${(response?.totals.urgent ?? 0) > 0 ? ' rr-kpi-v--bad' : ''}`}>{formatInteger(response?.totals.urgent ?? 0)}</div>
          </div>
          <div className="rr-kpi"><div className="rr-kpi-l">Дефицит листовых</div><div className="rr-kpi-v">{formatQuantity(response?.totals.deficitM2 ?? 0, 'm2')}</div></div>
          <div className="rr-kpi"><div className="rr-kpi-l">Дефицит плёнки</div><div className="rr-kpi-v">{formatQuantity(response?.totals.deficitLm ?? 0, 'lm')}</div></div>
        </div>
        {response && (
          <div className="rr-hint">
            «Нужно к» = плановая дата − {response.settings.leadDays} раб. дн. Заказы: незавершённые и невыданные, без плановой даты или с датой
            {response.window.plannedFrom ? ` с ${formatDate(response.window.plannedFrom)}` : ''}{response.window.plannedTo ? ` по ${formatDate(response.window.plannedTo)}` : ''}
            {response.window.plannedFrom ? ' (более старые — через поиск или «Нужно к: с»)' : ''}; всего {response.window.ordersCount}.
          </div>
        )}
      </div>

      <div className="rr-legend">
        <span><i className="rr-dot" style={{ background: 'var(--rr-ok)' }} />пришло</span>
        <span><i className="rr-dot" style={{ background: 'var(--rr-ordered)' }} />заказано поставщику</span>
        <span><i className="rr-dot" style={{ background: 'var(--rr-none-soft)', outline: '1px solid var(--rr-border)' }} />дефицит</span>
        <span><i className="rr-dot" style={{ background: KIND_COLORS.sheet_material }} />листовой материал</span>
        <span><i className="rr-dot" style={{ background: KIND_COLORS.film }} />плёнка</span>
      </div>

      <Table<WorklistRow>
        className="rr-table"
        rowKey="lineKey"
        dataSource={tableRows}
        columns={groupColumns}
        rowSelection={worklistSelection}
        loading={loading && !response}
        pagination={state.groupBy === 'none'
          ? { current: page, onChange: setPage, pageSize: PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true, style: { padding: '0 16px' } }
          : false}
        rowClassName={(row) => (isGroupRow(row) ? 'rr-grp' : row.lineKey === focusedKey ? 'rr-focus' : '')}
        scroll={{ x: 1100 }}
        locale={{ emptyText: <Empty description={state.preset === 'action' ? 'Всё покрыто — действий не требуется' : 'Нет позиций'} /> }}
      />

      {selected.size > 0 && (
        <div className="rr-sticky" role="region" aria-label="Действия с выбранным">
          <span>Выбрано <b>{selected.size}</b> поз. · дефицит {selectionDeficit} · поставщиков: {selectedSuppliers}</span>
          <Tooltip title={markBlockReason ?? undefined}>
            <Button type="primary" loading={marking} disabled={markBlockReason !== null} onClick={() => void markPurchased()}>
              Отметить «Закуплено»
            </Button>
          </Tooltip>
          {response?.capabilities.supplierRequests && (
            <Button disabled={stale} onClick={formRequests}>Сформировать заявки</Button>
          )}
          <Button disabled={stale} onClick={() => void exportExcel()}>Выгрузить XLS</Button>
          <Button onClick={() => setSelected(new Set())}>Снять выделение</Button>
        </div>
      )}

      <HistoryDrawer line={historyLine} onClose={() => setHistoryLine(null)} />
    </div>
  );
}

type GroupRow = { rowType: 'group'; lineKey: string; group: NonNullable<ProcurementWorklistResponse['groups']>[number] };
type WorklistRow = ProcurementWorklistLine | GroupRow;

function isGroupRow(row: WorklistRow): row is GroupRow {
  return (row as GroupRow).rowType === 'group';
}

/** Колонки строк с встроенными строками групп: заголовок группы — на всю ширину таблицы. */
function withGroupRows(
  columns: NonNullable<TableProps<ProcurementWorklistLine>['columns']>,
  renderGroup: (group: GroupRow['group']) => ReactNode,
): NonNullable<TableProps<WorklistRow>['columns']> {
  return columns.map((column, index) => {
    const base = column as { render?: (value: unknown, row: ProcurementWorklistLine, index: number) => ReactNode };
    return {
      ...(column as object),
      onCell: (row: WorklistRow) => (isGroupRow(row) ? { colSpan: index === 0 ? columns.length : 0 } : {}),
      render: (value: unknown, row: WorklistRow, rowIndex: number) => (isGroupRow(row)
        ? (index === 0 ? renderGroup(row.group) : null)
        : base.render ? base.render(value, row, rowIndex) : (value as ReactNode)),
    };
  }) as NonNullable<TableProps<WorklistRow>['columns']>;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function summarizeDeficit(lines: ProcurementWorklistLine[]): string {
  const m2 = lines.reduce((sum, line) => sum + (line.unit === 'm2' ? line.deficit ?? 0 : 0), 0);
  const lm = lines.reduce((sum, line) => sum + (line.unit === 'lm' ? line.deficit ?? 0 : 0), 0);
  return [m2 ? formatQuantity(m2, 'm2') : '', lm ? formatQuantity(lm, 'lm') : ''].filter(Boolean).join(' + ') || '0';
}

function useWorklistColumns(
  today: string | null,
  onHistory: (line: ProcurementWorklistLine) => void,
): TableProps<ProcurementWorklistLine>['columns'] {
  return useMemo(() => [
    {
      title: 'Нужно к',
      key: 'due',
      width: 130,
      render: (_value, line) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
          <span className="rr-num">{formatDate(line.dueDate)}</span>
          <span className={`rr-tag rr-tag--${line.needsAction ? URGENCY_TONES[line.urgency] : 'none'}`}>{dueText(line)}</span>
        </div>
      ),
    },
    {
      title: 'Заказ',
      key: 'order',
      width: 200,
      render: (_value, line) => (
        <div>
          <Link to={`/orders/show/${line.orderId}`}>{line.fullNumber}</Link>
          <div className="rr-sub">{[line.clientName, line.orderStatus].filter(Boolean).join(' · ')}</div>
        </div>
      ),
    },
    {
      title: 'Материал',
      key: 'name',
      width: 220,
      render: (_value, line) => (
        <span>
          <i className="rr-dot" aria-label={line.kind === 'film' ? 'плёнка' : 'листовой материал'} style={{ background: KIND_COLORS[line.kind] }} />
          {line.name}
        </span>
      ),
    },
    {
      title: 'Поставщик',
      key: 'supplier',
      width: 180,
      render: (_value, line) => (
        <Tooltip title={line.supplier.others.length > 0 ? `Также: ${line.supplier.others.map((other) => other.name).join(', ')}` : undefined}>
          <div className={line.supplier.source === 'none' ? 'rr-muted' : undefined}>
            {line.supplier.name}
            {line.supplier.source === 'first_receipt' && <div className="rr-sub">первый приход</div>}
            {line.supplier.others.length > 0 && <div className="rr-sub">+ ещё {line.supplier.others.length}</div>}
          </div>
        </Tooltip>
      ),
    },
    {
      title: 'Покрытие',
      key: 'coverage',
      width: 230,
      render: (_value, line) => {
        const { covered, ordered } = coveragePercents(line);
        return (
          <div className="rr-cov">
            <div className="rr-bar">
              <i className="rr-rcv" style={{ width: `${covered}%` }} />
              <i className="rr-ord" style={{ width: `${ordered}%` }} />
            </div>
            <span className="rr-sub rr-num">
              {line.need === null
                ? 'нет раскроя — количество неизвестно'
                : `пришло ${formatQuantity(line.received, line.unit)} · заказано ${formatQuantity(line.orderedOpen, line.unit)} из ${formatQuantity(line.need, line.unit)}`}
              {line.purchaseOrigin === 'manual' && !line.received ? ' · отмечено вручную' : ''}
              {line.receivedIncompatibleCount > 0 ? ` · приходов в других единицах: ${line.receivedIncompatibleCount}` : ''}
            </span>
            {(line.requests ?? []).length > 0 && (
              <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                {(line.requests ?? []).map((ref) => {
                  const tag = requestRefTag(ref);
                  return <span key={ref.requestId} className={`rr-tag rr-tag--${tag.tone}`}>{tag.label}</span>;
                })}
              </span>
            )}
          </div>
        );
      },
    },
    {
      title: 'Дефицит',
      key: 'deficit',
      width: 120,
      align: 'right',
      render: (_value, line) => <b className="rr-num">{line.deficit ? formatQuantity(line.deficit, line.unit) : '—'}</b>,
    },
    {
      title: 'Статус',
      key: 'status',
      width: 200,
      render: (_value, line) => (
        <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
          <span className={`rr-tag rr-tag--${COVERAGE_TONES[line.coverage]}`}>{COVERAGE_LABELS[line.coverage].label}</span>
          {line.onecReceiptCount > 0 && <span className="rr-tag rr-tag--info">в приходе 1С</span>}
          {line.demandChangedSinceMark && <span className="rr-tag rr-tag--warn">потребность изменилась</span>}
        </span>
      ),
    },
    {
      title: '',
      key: 'history',
      width: 44,
      render: (_value, line) => (
        <Tooltip title="История">
          <Button
            size="small"
            type="text"
            icon={<HistoryOutlined />}
            aria-label={`История ${line.name} по заказу ${line.fullNumber}`}
            onClick={(event) => { event.stopPropagation(); onHistory(line); }}
          />
        </Tooltip>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [today, onHistory]);
}

function SavedViews({ state, onApply, active }: { state: WorklistState; onApply: (state: WorklistState) => void; active: boolean }) {
  const [views, setViews] = useState<ProcurementSavedView[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    procurementWorkspaceApi.savedViews().then((next) => { if (alive) setViews(next); }).catch(() => undefined);
    return () => { alive = false; };
  }, [active]);
  const currentQuery = stateToViewQuery(state);
  const current = views.find((view) => view.query === currentQuery);

  const persist = async (next: ProcurementSavedView[]) => {
    setSaving(true);
    try {
      setViews(await procurementWorkspaceApi.replaceSavedViews(next));
    } catch (saveError) {
      message.error(saveError instanceof Error ? saveError.message : 'Не удалось сохранить представления');
    } finally {
      setSaving(false);
    }
  };
  const saveCurrent = () => {
    let name = '';
    Modal.confirm({
      title: 'Сохранить представление',
      content: <Input autoFocus maxLength={60} placeholder="Например: Срочно по Мебель-Трейд" onChange={(event) => { name = event.target.value; }} />,
      okText: 'Сохранить',
      cancelText: 'Отмена',
      onOk: async () => {
        if (!name.trim()) { message.warning('Введите название'); throw new Error('empty'); }
        if (views.length >= 20) { message.warning('Не больше 20 представлений'); return; }
        await persist([...views, { id: crypto.randomUUID(), name: name.trim(), query: currentQuery }]);
      },
    });
  };

  return (
    <Space.Compact>
      <Select
        placeholder="Представления"
        style={{ width: 200 }}
        value={current?.id}
        onChange={(id) => { const view = views.find((item) => item.id === id); if (view) onApply(stateFromViewQuery(view.query)); }}
        options={views.map((view) => ({ value: view.id, label: view.name }))}
        notFoundContent="Нет сохранённых"
      />
      <Tooltip title="Сохранить текущие фильтры как представление">
        <Button icon={<SaveOutlined />} loading={saving} onClick={saveCurrent} aria-label="Сохранить представление" />
      </Tooltip>
      {current && (
        <Tooltip title="Удалить представление">
          <Button icon={<DeleteOutlined />} onClick={() => void persist(views.filter((view) => view.id !== current.id))} aria-label="Удалить представление" />
        </Tooltip>
      )}
    </Space.Compact>
  );
}
