import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Descriptions, Drawer, Input, Select, Space, Spin, Tag, Typography } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import { ApiError } from '../../api/apiError';
import { onecApi } from './onecApi';
import type { OnecAgentView, OnecEtlEntityState, OnecMirrorRow, OnecMirrorRowDetail, OnecMirrorState } from './onecApi.types';
import { ONEC_MIRROR_STATE_OPTIONS, onecEtlEntityLabel } from './onecFormat';

const { Text } = Typography;

/** Search debounce before the mirror list is refetched (spec: "search input (debounced)"). */
export const ONEC_MIRROR_SEARCH_DEBOUNCE_MS = 400;
const PAGE_SIZE = 50;

export interface MirrorTabProps {
  agents: OnecAgentView[];
}

function formatDate(value: string | null): string {
  return value ? new Date(value).toLocaleString('ru-RU') : '—';
}

function formatMirrorFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * «Данные 1С»: read-only browser of the ETL mirror (the 1C data copy) of one
 * entity of one agent, with search/state paging. Row data is loaded only when
 * a row is opened (list rows never carry the `data` body).
 */
export function MirrorTab({ agents }: MirrorTabProps) {
  const [agentId, setAgentId] = useState<string>(agents[0]?.agentId ?? '');
  const [entities, setEntities] = useState<OnecEtlEntityState[]>([]);
  const [entity, setEntity] = useState<string>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [state, setState] = useState<OnecMirrorState>('all');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<OnecMirrorRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openRowKey, setOpenRowKey] = useState<string | null>(null);

  // The agent/entity/filters currently selected; a response for anything else is dropped.
  const selectedAgent = useRef(agentId);
  const selectedEntity = useRef(entity);
  const selectedSearch = useRef(search);
  const selectedState = useRef(state);
  const selectedPage = useRef(page);
  selectedAgent.current = agentId;
  selectedEntity.current = entity;
  selectedSearch.current = search;
  selectedState.current = state;
  selectedPage.current = page;

  // Switching agents discards the previous agent's entity list/rows before anything else can use them.
  useEffect(() => {
    setEntities([]);
    setEntity('');
    setRows([]);
    setTotal(0);
    setPage(1);
  }, [agentId]);

  const entitiesSeq = useRef(0);
  useEffect(() => {
    if (!agentId) return;
    const seq = ++entitiesSeq.current;
    onecApi
      .listEtlEntities({ agentId })
      .then((data) => {
        if (seq !== entitiesSeq.current || selectedAgent.current !== agentId) return;
        setEntities(data);
        setEntity((prev) => prev || data[0]?.entity || '');
      })
      .catch(() => {
        if (seq !== entitiesSeq.current) return;
        setEntities([]);
      });
  }, [agentId]);

  // Debounce raw input before it becomes the actual search filter (and resets paging).
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, ONEC_MIRROR_SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchInput]);

  // A state-filter change (not driven by the debounced search effect) also resets paging.
  useEffect(() => {
    setPage(1);
  }, [state, entity]);

  const requestSeq = useRef(0);
  const load = useCallback(async () => {
    if (!agentId || !entity) {
      setRows([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    const seq = ++requestSeq.current;
    const requestKey = `${agentId}|${entity}|${search}|${state}|${page}`;
    setLoading(true);
    try {
      const data = await onecApi.listEtlMirror({
        agentId,
        entity,
        search: search || undefined,
        state,
        offset: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      const currentKey = `${selectedAgent.current}|${selectedEntity.current}|${selectedSearch.current}|${selectedState.current}|${selectedPage.current}`;
      if (seq !== requestSeq.current || requestKey !== currentKey) return;
      setRows(data.rows);
      setTotal(data.total);
      setLoadError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setLoadError(err instanceof ApiError ? err.message : 'Не удалось загрузить данные 1С');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [agentId, entity, search, state, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns = useMemo(
    () => [
      { title: 'Код', dataIndex: 'code', key: 'code', render: (v: string | null) => v ?? '—' },
      { title: 'Наименование', dataIndex: 'description', key: 'description', render: (v: string | null) => v ?? '—' },
      {
        title: 'Удалено в 1С',
        key: 'deleted',
        render: (_: unknown, row: OnecMirrorRow) => (row.deleted ? <Tag color="red">Да</Tag> : 'Нет'),
      },
      {
        title: 'Пропало в 1С',
        key: 'missingInSourceAt',
        render: (_: unknown, row: OnecMirrorRow) =>
          row.missingInSourceAt ? <Tag color="orange">{formatDate(row.missingInSourceAt)}</Tag> : '—',
      },
      {
        title: 'Изменено в копии',
        key: 'updatedAt',
        render: (_: unknown, row: OnecMirrorRow) => formatDate(row.updatedAt),
      },
    ],
    [],
  );

  const entityOptions = entities.map((row) => ({ value: row.entity, label: onecEtlEntityLabel(row.entity) }));

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
        <Select
          style={{ minWidth: 240 }}
          value={entity || undefined}
          onChange={setEntity}
          options={entityOptions}
          placeholder="Выберите сущность"
          disabled={entityOptions.length === 0}
        />
        <Input.Search
          style={{ minWidth: 240 }}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Поиск по коду и наименованию"
          allowClear
        />
        <Select style={{ minWidth: 240 }} value={state} onChange={setState} options={ONEC_MIRROR_STATE_OPTIONS} />
      </Space>

      {entity === 'counterparty_phones' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Персональные данные: доступ только администраторам, данные можно отозвать на вкладке ETL"
        />
      )}

      {loadError && <Alert type="error" showIcon message={loadError} style={{ marginBottom: 16 }} />}

      <Table<OnecMirrorRow>
        rowKey="sourceKey"
        loading={loading}
        dataSource={rows}
        columns={columns}
        pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
        onRow={(row) => ({ onClick: () => setOpenRowKey(row.sourceKey) })}
      />

      {openRowKey && agentId && entity && (
        <MirrorRowDrawer agentId={agentId} entity={entity} sourceKey={openRowKey} onClose={() => setOpenRowKey(null)} />
      )}
    </div>
  );
}

function MirrorRowDrawer({
  agentId,
  entity,
  sourceKey,
  onClose,
}: {
  agentId: string;
  entity: string;
  sourceKey: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<OnecMirrorRowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    onecApi
      .getEtlMirrorRow({ agentId, entity, key: sourceKey })
      .then((data) => {
        if (!cancelled) setDetail(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Не удалось загрузить строку');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, entity, sourceKey]);

  return (
    <Drawer title="Строка данных 1С" open onClose={onClose} width={560}>
      {loading && <Spin />}
      {error && <Alert type="error" showIcon message={error} />}
      {detail && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Ключ">
              <Text code copyable>
                {detail.sourceKey}
              </Text>
            </Descriptions.Item>
            <Descriptions.Item label="Сущность">{onecEtlEntityLabel(detail.entity)}</Descriptions.Item>
            <Descriptions.Item label="Удалено в 1С">{detail.deleted ? 'Да' : 'Нет'}</Descriptions.Item>
            <Descriptions.Item label="Пропало в 1С">{formatDate(detail.missingInSourceAt)}</Descriptions.Item>
            <Descriptions.Item label="Изменено в источнике">{formatDate(detail.sourceUpdatedAt)}</Descriptions.Item>
            <Descriptions.Item label="Изменено в копии">{formatDate(detail.updatedAt)}</Descriptions.Item>
            <Descriptions.Item label="Первая выгрузка">{detail.firstSeenRun ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Последняя выгрузка">{detail.lastRunId ?? '—'}</Descriptions.Item>
          </Descriptions>

          <div>
            <Text strong>Поля</Text>
            <Descriptions column={1} size="small" bordered style={{ marginTop: 8 }}>
              {Object.entries(detail.data ?? {}).map(([key, value]) => (
                <Descriptions.Item key={key} label={key}>
                  {formatMirrorFieldValue(value)}
                </Descriptions.Item>
              ))}
            </Descriptions>
          </div>

          <div>
            <Text strong>JSON</Text>
            <pre style={{ background: '#f5f5f5', padding: 12, maxHeight: 300, overflow: 'auto' }}>
              {JSON.stringify(detail.data, null, 2)}
            </pre>
          </div>
        </Space>
      )}
    </Drawer>
  );
}
