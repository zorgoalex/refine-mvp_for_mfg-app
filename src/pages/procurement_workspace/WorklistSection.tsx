import { DeleteOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Badge, Button, Card, Col, DatePicker, Empty, Input, Modal, Row, Select, Space, Statistic, Tag, Typography, message } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Segmented } from '../../ui/Segmented';
import { Table, Tooltip, type TableProps } from '../../ui/tooltipDelay';
import { useProcurementPermission } from '../order_resource_requirements/ProcurementParts';
import {
  COVERAGE_LABELS,
  URGENCY_COLORS,
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
const PAGE_SIZE = 50;

export interface WorklistSectionProps {
  /** Вкладка видна: иначе без опроса сервера и горячих клавиш. */
  active: boolean;
  /** Счётчик срочных позиций — для бейджа вкладки. */
  onUrgentCount?: (count: number) => void;
}

export function WorklistSection({ active, onUrgentCount }: WorklistSectionProps) {
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

  const columns = useWorklistColumns(response?.today ?? null);
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

  const table = (rows: ProcurementWorklistLine[], paginated: boolean) => (
    <Table<ProcurementWorklistLine>
      size="small"
      rowKey="lineKey"
      dataSource={rows}
      columns={columns}
      rowSelection={rowSelection}
      loading={loading && !response}
      pagination={paginated ? { current: page, onChange: setPage, pageSize: PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true } : false}
      rowClassName={(row) => (row.lineKey === focusedKey ? 'ant-table-row-selected' : '')}
      scroll={{ x: 1100 }}
      locale={{ emptyText: <Empty description={state.preset === 'action' ? 'Всё покрыто — действий не требуется' : 'Нет позиций'} /> }}
    />
  );

  const selectionDeficit = summarizeDeficit(selectedLines);
  const selectedSuppliers = new Set(selectedLines.map((line) => line.supplier.key)).size;

  return (
    <Space direction="vertical" size={12} style={{ width: '100%', paddingBottom: selected.size > 0 ? 72 : 0 }}>
      <Space wrap size={[8, 8]} style={{ width: '100%' }}>
        <Segmented
          aria-label="Набор"
          value={state.preset}
          onChange={(value) => setState({ preset: value as WorklistPreset })}
          options={[
            { value: 'action', label: <span>Требует действия <Badge count={response?.counts.action ?? 0} showZero color="#8c8c8c" /></span> },
            { value: 'urgent', label: <span>Срочно на этой неделе <Badge count={response?.counts.urgent ?? 0} showZero /></span> },
            { value: 'all', label: <span>Всё <Badge count={response?.counts.all ?? 0} showZero color="#8c8c8c" /></span> },
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
        <Input.Search
          allowClear
          placeholder="Заказ, клиент, материал, поставщик"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ width: 280 }}
        />
        <DatePicker.RangePicker
          format="DD.MM.YYYY"
          placeholder={['Нужно к: с', 'по']}
          value={state.dueFrom || state.dueTo ? [state.dueFrom ? dayjs(state.dueFrom) : null, state.dueTo ? dayjs(state.dueTo) : null] : null}
          onChange={(range) => setState({
            dueFrom: range?.[0] ? range[0].format('YYYY-MM-DD') : null,
            dueTo: range?.[1] ? range[1].format('YYYY-MM-DD') : null,
          })}
        />
        <Select
          allowClear
          placeholder="Вид"
          style={{ width: 140 }}
          value={state.kind ?? undefined}
          onChange={(value) => setState({ kind: value ?? null })}
          options={[{ value: 'sheet_material', label: 'Листовые' }, { value: 'film', label: 'Плёнка' }]}
        />
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="Поставщик"
          style={{ width: 200 }}
          value={state.supplierKey ?? undefined}
          onChange={(value) => setState({ supplierKey: value ?? null })}
          options={supplierOptions}
        />
        <Select
          mode="multiple"
          allowClear
          placeholder="Покрытие"
          style={{ minWidth: 180 }}
          value={state.coverage}
          onChange={(value) => setState({ coverage: value })}
          options={Object.entries(COVERAGE_LABELS).map(([value, { label }]) => ({ value, label }))}
        />
        <SavedViews state={state} onApply={(next) => setState(next)} active={active} />
        <Tooltip title="Обновить">
          <Button icon={<ReloadOutlined />} onClick={refresh} aria-label="Обновить" />
        </Tooltip>
      </Space>

      {state.onecDocumentId !== null && (
        <Tag closable onClose={() => setState({ onecDocumentId: null })}>Только позиции документа 1С #{state.onecDocumentId}</Tag>
      )}
      {error && <Alert type="error" showIcon message={error} />}

      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Не покрыто позиций" value={response?.totals.uncovered ?? 0} /></Card></Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title={`Срочно (≤ ${response?.settings.soonDays ?? 7} дн.)`}
              value={response?.totals.urgent ?? 0}
              valueStyle={{ color: (response?.totals.urgent ?? 0) > 0 ? '#cf1322' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Дефицит листовых, м²" value={response?.totals.deficitM2 ?? 0} precision={2} /></Card></Col>
        <Col xs={12} md={6}><Card size="small"><Statistic title="Дефицит плёнки, пог. м" value={response?.totals.deficitLm ?? 0} precision={1} /></Card></Col>
      </Row>
      {response && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          «Нужно к» = плановая дата − {response.settings.leadDays} раб. дн. Заказы: незавершённые и невыданные, без плановой даты или с датой
          {response.window.plannedFrom ? ` с ${formatDate(response.window.plannedFrom)}` : ''}{response.window.plannedTo ? ` по ${formatDate(response.window.plannedTo)}` : ''}
          {response.window.plannedFrom ? ' (более старые — через поиск или «Нужно к: с»)' : ''}; всего {response.window.ordersCount}.
        </Typography.Text>
      )}

      {state.groupBy === 'none' || !response
        ? table(lines, true)
        : response.groups.map((group) => {
          const groupLines = group.lineKeys.map((key) => lineByKey.get(key)).filter(Boolean) as ProcurementWorklistLine[];
          const whole = isGroupSelected(group.lineKeys, selected);
          return (
            <Card
              key={group.key}
              size="small"
              title={(
                <Space wrap>
                  <Typography.Text strong>{group.label}</Typography.Text>
                  <Typography.Text type="secondary">
                    {group.linesCount} поз. · дефицит {[group.deficitM2 ? formatQuantity(group.deficitM2, 'm2') : '', group.deficitLm ? formatQuantity(group.deficitLm, 'lm') : ''].filter(Boolean).join(' + ') || '0'}
                  </Typography.Text>
                  <Button size="small" disabled={stale} onClick={() => setSelected((current) => toggleGroupSelection(group.lineKeys, current))}>
                    {whole ? 'Снять выделение' : 'Выделить группу'}
                  </Button>
                </Space>
              )}
            >
              {table(groupLines, false)}
            </Card>
          );
        })}

      {selected.size > 0 && (
        <div
          role="region"
          aria-label="Действия с выбранным"
          style={{
            position: 'fixed', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 20,
            background: 'var(--ant-color-bg-elevated, #1f1f1f)', color: 'inherit', borderRadius: 12, padding: '10px 14px',
            boxShadow: '0 8px 30px rgba(0,0,0,.25)', maxWidth: 'calc(100% - 32px)',
          }}
        >
          <Space wrap>
            <Typography.Text>
              Выбрано <b>{selected.size}</b> поз. · дефицит {selectionDeficit} · поставщиков: {selectedSuppliers}
            </Typography.Text>
            <Tooltip title={markBlockReason ?? undefined}>
              <Button type="primary" loading={marking} disabled={markBlockReason !== null} onClick={() => void markPurchased()}>
                Отметить «Закуплено»
              </Button>
            </Tooltip>
            <Button disabled={stale} onClick={() => void exportExcel()}>Выгрузить в Excel</Button>
            <Button onClick={() => setSelected(new Set())}>Снять выделение</Button>
          </Space>
        </div>
      )}
    </Space>
  );
}

function summarizeDeficit(lines: ProcurementWorklistLine[]): string {
  const m2 = lines.reduce((sum, line) => sum + (line.unit === 'm2' ? line.deficit ?? 0 : 0), 0);
  const lm = lines.reduce((sum, line) => sum + (line.unit === 'lm' ? line.deficit ?? 0 : 0), 0);
  return [m2 ? formatQuantity(m2, 'm2') : '', lm ? formatQuantity(lm, 'lm') : ''].filter(Boolean).join(' + ') || '0';
}

function useWorklistColumns(today: string | null): TableProps<ProcurementWorklistLine>['columns'] {
  return useMemo(() => [
    {
      title: 'Нужно к',
      key: 'due',
      width: 130,
      render: (_value, line) => (
        <Space direction="vertical" size={0}>
          <span>{formatDate(line.dueDate)}</span>
          <Tag color={line.needsAction ? URGENCY_COLORS[line.urgency] : 'default'} style={{ marginInlineEnd: 0 }}>{dueText(line)}</Tag>
        </Space>
      ),
    },
    {
      title: 'Заказ',
      key: 'order',
      width: 200,
      render: (_value, line) => (
        <Space direction="vertical" size={0}>
          <Link to={`/orders/show/${line.orderId}`}>{line.fullNumber}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[line.clientName, line.orderStatus].filter(Boolean).join(' · ')}
          </Typography.Text>
        </Space>
      ),
    },
    { title: 'Материал', dataIndex: 'name', key: 'name', width: 220 },
    {
      title: 'Поставщик',
      key: 'supplier',
      width: 180,
      render: (_value, line) => (
        <Tooltip title={line.supplier.others.length > 0 ? `Также: ${line.supplier.others.map((other) => other.name).join(', ')}` : undefined}>
          <Space direction="vertical" size={0}>
            <span>{line.supplier.name}</span>
            {line.supplier.source === 'first_receipt' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>первый приход</Typography.Text>}
            {line.supplier.others.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>+ ещё {line.supplier.others.length}</Typography.Text>}
          </Space>
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
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: 'var(--ant-color-fill-secondary, #f0f0f0)' }}>
              <div style={{ width: `${covered}%`, background: '#52c41a' }} />
              <div style={{ width: `${ordered}%`, background: '#7c8cf8' }} />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {line.need === null
                ? 'нет раскроя — количество неизвестно'
                : `покрыто ${formatQuantity(line.covered, line.unit)} из ${formatQuantity(line.need, line.unit)}`}
              {line.receivedIncompatibleCount > 0 ? ` · приходов в других единицах: ${line.receivedIncompatibleCount}` : ''}
            </Typography.Text>
          </Space>
        );
      },
    },
    {
      title: 'Дефицит',
      key: 'deficit',
      width: 120,
      align: 'right',
      render: (_value, line) => <b>{line.deficit ? formatQuantity(line.deficit, line.unit) : '—'}</b>,
    },
    {
      title: 'Статус',
      key: 'status',
      width: 200,
      render: (_value, line) => (
        <Space wrap size={4}>
          <Tag color={COVERAGE_LABELS[line.coverage].color}>{COVERAGE_LABELS[line.coverage].label}</Tag>
          {line.purchased && <Tag>{line.purchaseOrigin === 'onec' ? 'отмечено приходом' : 'отмечено вручную'}</Tag>}
          {line.demandChangedSinceMark && <Tag color="warning">потребность изменилась</Tag>}
        </Space>
      ),
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [today]);
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
