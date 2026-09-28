import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Card, Input, Select, Space, Tag, Typography } from 'antd';
import { Table, Tooltip } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type {
  OnecAgentView,
  OnecCounterpartyMatchRow,
  OnecCounterpartyMatchSummary,
  OnecItemCategoryDistribution,
  OnecMatchRoleFilter,
  OnecMatchStatusFilter,
} from './onecApi.types';
import {
  ONEC_MATCH_ROLE_OPTIONS,
  ONEC_MATCH_STATUS_OPTIONS,
  onecBinValidityLabel,
  onecItemCategoryNameLabel,
  onecItemTypeBreakdownLabel,
  onecMatchLine,
  onecMatchStatusColor,
  onecMatchStatusLabel,
  onecMatchSummaryBreakdownLabel,
} from './onecFormat';

const { Text } = Typography;

/** Search debounce before the counterparty list is refetched (same cadence as «Данные 1С»). */
export const ONEC_MATCHING_SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 50;

export interface MatchingTabProps {
  agents: OnecAgentView[];
}

/**
 * «Сопоставление»: read-only report of how the 1C copy lines up with ERP reference
 * data (plan §9, E3c) — 1C counterparties against ERP clients/suppliers, and 1C
 * nomenclature per category/type. Nothing here writes anywhere; binding 1C keys to
 * ERP rows is a later step.
 */
export function MatchingTab({ agents }: MatchingTabProps) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.agentId ?? '');
  const [status, setStatus] = useState<OnecMatchStatusFilter>('all');
  const [role, setRole] = useState<OnecMatchRoleFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [summary, setSummary] = useState<OnecCounterpartyMatchSummary | null>(null);
  const [suggestionsAvailable, setSuggestionsAvailable] = useState(false);
  const [rows, setRows] = useState<OnecCounterpartyMatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [categories, setCategories] = useState<OnecItemCategoryDistribution[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);

  // The agent/filters currently selected; a response for anything else is dropped.
  const selectedAgent = useRef(agentId);
  const selectedStatus = useRef(status);
  const selectedRole = useRef(role);
  const selectedSearch = useRef(search);
  const selectedPage = useRef(page);
  selectedAgent.current = agentId;
  selectedStatus.current = status;
  selectedRole.current = role;
  selectedSearch.current = search;
  selectedPage.current = page;

  // Switching agents discards the previous agent's report before anything else can use it.
  useEffect(() => {
    setSummary(null);
    setSuggestionsAvailable(false);
    setRows([]);
    setTotal(0);
    setPage(1);
    setCategories([]);
  }, [agentId]);

  // Debounce raw input before it becomes the actual search filter (and resets paging).
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, ONEC_MATCHING_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchInput]);

  // A filter change (not driven by the debounced search effect) also resets paging.
  useEffect(() => {
    setPage(1);
  }, [status, role]);

  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    if (!agentId) {
      setSummary(null);
      setSuggestionsAvailable(false);
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    const requestKey = `${agentId}|${status}|${role}|${search}|${page}`;
    setLoading(true);
    try {
      const data = await onecApi.listMatchingCounterparties({
        agentId,
        status,
        role,
        search: search || undefined,
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      const currentKey = `${selectedAgent.current}|${selectedStatus.current}|${selectedRole.current}|${selectedSearch.current}|${selectedPage.current}`;
      if (seq !== requestSeq.current || requestKey !== currentKey) return;
      setSummary(data.summary);
      setSuggestionsAvailable(data.suggestionsAvailable);
      setRows(data.rows);
      setTotal(data.total);
      setLoadError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить сопоставление контрагентов');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [agentId, status, role, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Item distribution has no filters/paging of its own: reload only when the agent changes.
  const itemsSeq = useRef(0);
  const itemsSelectedAgent = useRef(agentId);
  itemsSelectedAgent.current = agentId;
  useEffect(() => {
    if (!agentId) {
      setCategories([]);
      setItemsLoading(false);
      return undefined;
    }
    const seq = ++itemsSeq.current;
    setItemsLoading(true);
    onecApi
      .getMatchingItems(agentId)
      .then((data) => {
        if (seq !== itemsSeq.current || itemsSelectedAgent.current !== agentId) return;
        setCategories(data.categories);
        setItemsError(null);
      })
      .catch((err) => {
        if (seq !== itemsSeq.current) return;
        setItemsError(err instanceof ApiError ? err.message : 'Не удалось загрузить распределение номенклатуры');
      })
      .finally(() => {
        if (seq === itemsSeq.current) setItemsLoading(false);
      });
    return undefined;
  }, [agentId]);

  const counterpartyColumns = useMemo(
    () => [
      { title: 'Код', dataIndex: 'code', key: 'code', render: (v: string | null) => v ?? '—' },
      {
        title: 'Наименование',
        key: 'name',
        render: (_: unknown, row: OnecCounterpartyMatchRow) => (
          <Space size={4} wrap>
            {row.fullName && row.fullName !== row.name ? (
              <Tooltip title={row.fullName}>
                <span>{row.name ?? '—'}</span>
              </Tooltip>
            ) : (
              <span>{row.name ?? '—'}</span>
            )}
            {row.deleted && <Tag color="red">Удалено в 1С</Tag>}
            {row.missing && <Tag color="orange">Пропало в 1С</Tag>}
          </Space>
        ),
      },
      {
        title: 'БИН/ИИН',
        key: 'bin',
        render: (_: unknown, row: OnecCounterpartyMatchRow) => {
          const invalid = onecBinValidityLabel(row.binValid);
          if (!row.bin) return '—';
          return (
            <Space size={4}>
              <Text>{row.bin}</Text>
              {invalid && <Tag color="red">{invalid}</Tag>}
            </Space>
          );
        },
      },
      {
        title: 'Роль',
        key: 'role',
        render: (_: unknown, row: OnecCounterpartyMatchRow) => (
          <Space size={4}>
            {row.buyer && <Tag color="blue">Покупатель</Tag>}
            {row.supplier && <Tag color="purple">Поставщик</Tag>}
            {!row.buyer && !row.supplier && '—'}
          </Space>
        ),
      },
      {
        title: 'Статус',
        key: 'status',
        render: (_: unknown, row: OnecCounterpartyMatchRow) => (
          <Tag color={onecMatchStatusColor(row.status)}>{onecMatchStatusLabel(row.status)}</Tag>
        ),
      },
      {
        title: 'Совпадения в ERP',
        key: 'matches',
        render: (_: unknown, row: OnecCounterpartyMatchRow) =>
          row.matches.length === 0 ? (
            '—'
          ) : (
            <Space direction="vertical" size={0}>
              {row.matches.map((match) => (
                <Text key={`${match.kind}:${match.id}`}>{onecMatchLine(match)}</Text>
              ))}
            </Space>
          ),
      },
      ...(suggestionsAvailable
        ? [
            {
              title: 'Похожие',
              key: 'suggestions',
              render: (_: unknown, row: OnecCounterpartyMatchRow) =>
                row.status !== 'unmatched' || row.suggestions.length === 0 ? (
                  '—'
                ) : (
                  <Space direction="vertical" size={0}>
                    {row.suggestions.map((s) => (
                      <Text key={`${s.kind}:${s.id}`} type="secondary">
                        {onecMatchLine({ kind: s.kind, name: s.name, by: [] })} ({s.score})
                      </Text>
                    ))}
                  </Space>
                ),
            },
          ]
        : []),
    ],
    [suggestionsAvailable],
  );

  const categoryColumns = useMemo(
    () => [
      {
        title: 'Категория',
        key: 'category',
        render: (_: unknown, row: OnecItemCategoryDistribution) => onecItemCategoryNameLabel(row.categoryName),
      },
      {
        title: 'Тип по умолчанию',
        dataIndex: 'defaultType',
        key: 'defaultType',
        render: (v: string | null) => v ?? '—',
      },
      { title: 'Всего', dataIndex: 'total', key: 'total' },
      {
        title: 'По типам',
        key: 'byType',
        render: (_: unknown, row: OnecItemCategoryDistribution) => onecItemTypeBreakdownLabel(row.byType) || '—',
      },
      { title: 'С ценой', dataIndex: 'withPrice', key: 'withPrice' },
      { title: 'С остатком', dataIndex: 'withStock', key: 'withStock' },
      { title: 'Пропало в 1С', dataIndex: 'missing', key: 'missing' },
      { title: 'Удалено', dataIndex: 'deleted', key: 'deleted' },
    ],
    [],
  );

  return (
    <div>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          style={{ minWidth: 260 }}
          value={agentId || undefined}
          onChange={setAgentId}
          options={agents.map((agent) => ({ value: agent.agentId, label: agent.displayName }))}
          placeholder="Выберите агента"
        />
      </Space>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Отчёт только для чтения: ничего в ERP не меняется. Привязка ключей 1С к записям ERP появится позже."
      />

      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Card title="Контрагенты 1С ↔ клиенты и поставщики ERP" size="small">
          {summary && (
            <Space style={{ marginBottom: 12 }} wrap>
              <Tag>Всего: {summary.total}</Tag>
              <Tag>Покупателей: {summary.buyers}</Tag>
              <Tag>Поставщиков: {summary.suppliers}</Tag>
              <Tag color="green">Сопоставлено: {summary.matched}</Tag>
              <Tag color="orange">Неоднозначно: {summary.ambiguous}</Tag>
              <Tag>Без пары: {summary.unmatched}</Tag>
              <Text type="secondary">{onecMatchSummaryBreakdownLabel(summary)}</Text>
            </Space>
          )}

          <Space style={{ marginBottom: 16 }} wrap>
            <Select style={{ minWidth: 200 }} value={status} onChange={setStatus} options={ONEC_MATCH_STATUS_OPTIONS} />
            <Select style={{ minWidth: 200 }} value={role} onChange={setRole} options={ONEC_MATCH_ROLE_OPTIONS} />
            <Input.Search
              style={{ minWidth: 260 }}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Поиск по наименованию, коду, БИН/ИИН"
              allowClear
            />
          </Space>

          {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}

          <Table<OnecCounterpartyMatchRow>
            rowKey="sourceKey"
            loading={loading}
            dataSource={rows}
            columns={counterpartyColumns}
            pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
          />
        </Card>

        <Card title="Номенклатура 1С по категориям" size="small">
          {itemsError && <Alert type="error" showIcon message={itemsError} style={{ marginBottom: 16 }} />}
          <Table<OnecItemCategoryDistribution>
            rowKey={(row) => row.categoryKey ?? '__none__'}
            loading={itemsLoading}
            dataSource={categories}
            columns={categoryColumns}
            pagination={false}
          />
        </Card>
      </Space>
    </div>
  );
}
