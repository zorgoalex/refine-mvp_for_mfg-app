import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DatePicker, Input, Select, Space, Tag, Typography, message } from 'antd';
import type { Dayjs } from 'dayjs';
import { Table } from '../../ui/tooltipDelay';
import { Segmented } from '../../ui/Segmented';
import { ApiError } from '../../api/apiError';
import { integrationDuplicatesApi } from '../../api/integrationDuplicatesApi';
import type {
  DuplicateCaseView,
  DuplicateListResult,
  DuplicateRule,
  DuplicateStatusFilter,
  DuplicateSystem,
} from '../../api/integrationDuplicatesApiTypes';
import {
  DUPLICATE_STATUS_COLORS,
  DUPLICATE_STATUS_LABELS,
  DUPLICATE_STATUS_ORDER,
  DUPLICATE_STRENGTH_LABELS,
  DUPLICATE_SYSTEM_COLORS,
  DUPLICATE_SYSTEM_LABELS,
  activeMembers,
  caseAuthor,
  formatDateTime,
  keyMaskText,
  memberName,
  viaLabel,
} from './duplicatesModel';
import { DuplicateDrawer } from './DuplicateDrawer';

const { Text } = Typography;
const { RangePicker } = DatePicker;
const PAGE_SIZE = 50;

export function DuplicatesTab({ canResolve }: { canResolve: boolean }) {
  const [status, setStatus] = useState<DuplicateStatusFilter>('open');
  const [entityKind, setEntityKind] = useState<string | undefined>();
  const [ruleCode, setRuleCode] = useState<string | undefined>();
  const [system, setSystem] = useState<DuplicateSystem | undefined>();
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [rules, setRules] = useState<DuplicateRule[]>([]);
  const [data, setData] = useState<DuplicateListResult>({ items: [], total: 0, counts: {} });
  const [loading, setLoading] = useState(true);
  const [openCaseId, setOpenCaseId] = useState<number | null>(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    integrationDuplicatesApi.rules().then(setRules).catch(() => setRules([]));
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const result = await integrationDuplicatesApi.list({
        status,
        entityKind,
        ruleCode,
        system,
        from: range?.[0] ? range[0].startOf('day').toISOString() : undefined,
        to: range?.[1] ? range[1].endOf('day').toISOString() : undefined,
        search,
        page,
        pageSize: PAGE_SIZE,
      });
      if (seq === requestSeq.current) setData(result);
    } catch (err) {
      if (seq === requestSeq.current) {
        message.error(err instanceof ApiError ? err.message : 'Не удалось загрузить журнал дублей');
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [status, entityKind, ruleCode, system, range, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const kindOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const rule of rules) if (!seen.has(rule.entityKind)) seen.set(rule.entityKind, rule.entityKind);
    for (const item of data.items) seen.set(item.entityKind, item.entityKindLabel);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [rules, data.items]);

  const ruleOptions = useMemo(
    () => rules
      .filter((rule) => !entityKind || rule.entityKind === entityKind)
      .map((rule) => ({ value: rule.code, label: rule.label })),
    [rules, entityKind],
  );

  const statusOptions = [
    ...DUPLICATE_STATUS_ORDER.map((value) => ({
      value,
      label: `${DUPLICATE_STATUS_LABELS[value]} (${data.counts[value] ?? 0})`,
    })),
    { value: 'all', label: 'Все' },
  ];

  const reset = () => setPage(1);

  const columns = [
    { title: 'Дело', dataIndex: 'caseId', key: 'caseId', width: 80, render: (id: number) => `#${id}` },
    { title: 'Вид', dataIndex: 'entityKindLabel', key: 'kind', width: 130 },
    {
      title: 'Правило', key: 'rule', width: 230,
      render: (_: unknown, row: DuplicateCaseView) => (
        <Space size={4} wrap>
          <span>{row.ruleLabel}</span>
          <Tag color={row.strength === 'exact' ? 'red' : 'gold'}>{DUPLICATE_STRENGTH_LABELS[row.strength]}</Tag>
        </Space>
      ),
    },
    {
      title: 'Ключ', key: 'key', width: 170,
      render: (_: unknown, row: DuplicateCaseView) => (
        row.keyMask ? <Text code>{row.keyMask}</Text> : <Text type="secondary">{keyMaskText(row)}</Text>
      ),
    },
    {
      title: 'Участники', key: 'members',
      render: (_: unknown, row: DuplicateCaseView) => {
        const present = activeMembers(row.members);
        return (
          <Space direction="vertical" size={2}>
            <Text>{present.length}</Text>
            {present.map((member) => (
              <Space size={4} key={`${member.system}:${member.recordKey}`}>
                <Tag color={DUPLICATE_SYSTEM_COLORS[member.system]} style={{ marginInlineEnd: 0 }}>
                  {DUPLICATE_SYSTEM_LABELS[member.system]}
                </Tag>
                <span>{memberName(member)}</span>
              </Space>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Обнаружено', key: 'first', width: 160,
      render: (_: unknown, row: DuplicateCaseView) => (
        <Space direction="vertical" size={0}>
          <span>{formatDateTime(row.firstDetectedAt)}</span>
          <Text type="secondary">{viaLabel(row.detectedVia)}</Text>
        </Space>
      ),
    },
    { title: 'Последнее появление', dataIndex: 'lastSeenAt', key: 'last', width: 160, render: formatDateTime },
    {
      title: 'Автор', key: 'author', width: 130,
      render: (_: unknown, row: DuplicateCaseView) => caseAuthor(row.members),
    },
    {
      title: 'Статус', dataIndex: 'status', key: 'status', width: 140,
      render: (value: DuplicateCaseView['status']) => (
        <Tag color={DUPLICATE_STATUS_COLORS[value]}>{DUPLICATE_STATUS_LABELS[value]}</Tag>
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Segmented
        value={status}
        options={statusOptions}
        onChange={(value) => { setStatus(value as DuplicateStatusFilter); reset(); }}
      />
      <Space wrap>
        <Select
          allowClear placeholder="Вид" style={{ width: 180 }} options={kindOptions} value={entityKind}
          onChange={(value) => { setEntityKind(value); setRuleCode(undefined); reset(); }}
        />
        <Select
          allowClear placeholder="Правило" style={{ width: 260 }} options={ruleOptions} value={ruleCode}
          onChange={(value) => { setRuleCode(value); reset(); }}
        />
        <Select
          allowClear placeholder="Система" style={{ width: 140 }} value={system}
          options={(Object.keys(DUPLICATE_SYSTEM_LABELS) as DuplicateSystem[]).map((value) => ({ value, label: DUPLICATE_SYSTEM_LABELS[value] }))}
          onChange={(value) => { setSystem(value); reset(); }}
        />
        <RangePicker
          format="DD.MM.YYYY"
          onChange={(value) => { setRange(value); reset(); }}
        />
        <Input.Search
          allowClear placeholder="Название или номер" style={{ width: 240 }}
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onSearch={(value) => { setSearch(value); reset(); }}
        />
      </Space>
      <Table<DuplicateCaseView>
        size="small"
        rowKey="caseId"
        loading={loading}
        dataSource={data.items}
        columns={columns}
        scroll={{ x: 1300 }}
        locale={{ emptyText: 'Дублей не найдено' }}
        pagination={{
          current: page, pageSize: PAGE_SIZE, total: data.total, showSizeChanger: false,
          onChange: setPage,
        }}
        onRow={(row) => ({ onClick: () => setOpenCaseId(row.caseId), style: { cursor: 'pointer' } })}
      />
      <DuplicateDrawer
        caseId={openCaseId}
        canResolve={canResolve}
        onSelectCase={setOpenCaseId}
        onClose={() => setOpenCaseId(null)}
        onChanged={() => void load()}
      />
    </Space>
  );
}
