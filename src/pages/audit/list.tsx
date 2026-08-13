import { Table, Tooltip } from '../../ui/tooltipDelay';
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Form, Button, Card, Space, Typography, Tag, Empty, Alert, DatePicker, Segmented, Select, Tabs } from 'antd';
import { FilterOutlined, ClearOutlined, AuditOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { auditApi } from '../../api/auditApi';
import type {
  AuditFilterOptions,
  AuditLogEventDto,
  AuditLogListQuery,
  AuditOrderFilterOption,
  AuditParticipantFilterOption,
  AuditRelatedEntity,
  AuditRelatedEntityFilterOption,
  AuditUserFilterOption,
} from '../../api/types/auditApi.types';
import { ApiError } from '../../api/httpClient';
import { featureFlags } from '../../config/featureFlags';
import { authSession } from '../../api/authSession';
import { can } from '../../utils/permissions';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { buildAuditReadableSummary } from './readableSummary';
import { TelegramWorkerAudit } from './TelegramWorkerAudit';

const { Text } = Typography;

const PAGE_SIZE_DEFAULT = 50;

type AuditViewMode = 'readable' | 'technical';
type AuditTableMode = 'audit' | 'business-history';
type FilterSelectOption = { value: string | number; label: string };

const AUDIT_ENTITY_LABELS: Record<string, string> = {
  order: 'Заказ',
  order_detail: 'Деталь',
  detail: 'Деталь',
  client: 'Клиент',
  client_phone: 'Телефон клиента',
  payment: 'Платёж',
  deadline: 'Дедлайн',
  production_event: 'Производственное событие',
  user: 'Пользователь',
};

const EMPTY_FILTER_OPTIONS: AuditFilterOptions = {
  events: [],
  entityTypes: [],
  entityIds: [],
  users: [],
  roles: [],
  sources: [],
  relatedOrderIds: [],
  relatedClientIds: [],
  relatedPaymentIds: [],
  relatedDeadlineIds: [],
  relatedProductionEventIds: [],
  relatedUserIds: [],
  relatedEntityTypes: [],
  relatedEntities: [],
  requestIds: [],
};

export interface FilterValues {
  event?: string;
  events?: string[];
  entityType?: string;
  entityId?: string;
  userId?: number;
  orderIds?: number[];
  participantUserIds?: number[];
  role?: string;
  source?: string;
  relatedOrderId?: number;
  relatedClientId?: number;
  relatedPaymentId?: number;
  relatedDeadlineId?: number;
  relatedProductionEventId?: number;
  relatedUserId?: number;
  relatedEntityType?: string;
  relatedEntityId?: number;
  requestId?: string;
  createdRange?: [Dayjs, Dayjs];
  createdFrom?: Dayjs;
  createdTo?: Dayjs;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return dayjs(value).format('DD.MM.YYYY HH:mm:ss');
}

function stringSelectOptions(values: readonly string[]): FilterSelectOption[] {
  return values.map((value) => ({ value, label: value }));
}

function numberSelectOptions(values: readonly number[], prefix: string): FilterSelectOption[] {
  return values.map((value) => ({ value, label: `${prefix} #${value}` }));
}

function userSelectOptions(values: readonly AuditUserFilterOption[]): FilterSelectOption[] {
  return values.map((value) => {
    const name = value.username?.trim() || `Пользователь #${value.userId}`;
    const role = value.role ? ` · ${value.role}` : '';
    return { value: value.userId, label: `${name} (#${value.userId})${role}` };
  });
}

function orderLookupSelectOptions(values: readonly AuditOrderFilterOption[]): FilterSelectOption[] {
  return values.map((value) => ({
    value: value.orderId,
    label: orderLabel(value.orderId, value.orderName),
  }));
}

function participantLookupSelectOptions(values: readonly AuditParticipantFilterOption[]): FilterSelectOption[] {
  return values.map((value) => {
    const name = value.username?.trim() || `Пользователь #${value.userId}`;
    const role = value.role ? ` · ${value.role}` : '';
    return { value: value.userId, label: `${name} (#${value.userId})${role}` };
  });
}

function relatedEntityIdSelectOptions(
  values: readonly AuditRelatedEntityFilterOption[],
  entityType?: string
): FilterSelectOption[] {
  const seen = new Set<number>();
  const filtered = entityType ? values.filter((value) => value.entityType === entityType) : values;
  const options: FilterSelectOption[] = [];
  for (const value of filtered) {
    if (seen.has(value.entityId)) continue;
    seen.add(value.entityId);
    options.push({
      value: value.entityId,
      label: relatedEntityOptionLabel(value, Boolean(entityType)),
    });
  }
  return options;
}

function entityTypeLabel(entityType: string): string {
  return AUDIT_ENTITY_LABELS[entityType] ?? entityType;
}

function orderLabel(id: number | null | undefined, name?: string | null): string {
  const cleanName = name?.trim();
  if (cleanName && id != null) return `Заказ ${cleanName} (#${id})`;
  if (cleanName) return `Заказ ${cleanName}`;
  return id != null ? `Заказ #${id}` : 'Заказ';
}

function clientLabel(id: number | null | undefined, name?: string | null): string {
  const cleanName = name?.trim();
  if (cleanName && id != null) return `Клиент ${cleanName} (#${id})`;
  if (cleanName) return `Клиент ${cleanName}`;
  return id != null ? `Клиент #${id}` : 'Клиент';
}

function detailLabel(id: number | null | undefined, detailNumber?: number | null): string {
  if (detailNumber != null && id != null) return `Деталь №${detailNumber} (#${id})`;
  if (detailNumber != null) return `Деталь №${detailNumber}`;
  return id != null ? `Деталь #${id}` : 'Деталь';
}

function relatedEntityLabel(entity: AuditRelatedEntity): string {
  if (entity.entityType === 'order') return orderLabel(entity.entityId, entity.entityName);
  if (entity.entityType === 'client') return clientLabel(entity.entityId, entity.entityName);
  if (entity.entityType === 'order_detail' || entity.entityType === 'detail') {
    return detailLabel(entity.entityId, entity.detailNumber);
  }
  const base = entityTypeLabel(entity.entityType);
  const cleanName = entity.entityName?.trim();
  if (cleanName) return `${base} ${cleanName} (#${entity.entityId})`;
  return `${base} #${entity.entityId}`;
}

function relatedEntityOptionLabel(entity: AuditRelatedEntityFilterOption, omitType: boolean): string {
  if (entity.entityType === 'order') {
    const label = orderLabel(entity.entityId, entity.entityName);
    return omitType ? label.replace(/^Заказ\s+/, '') : label;
  }
  if (entity.entityType === 'client') {
    const label = clientLabel(entity.entityId, entity.entityName);
    return omitType ? label.replace(/^Клиент\s+/, '') : label;
  }
  if (entity.entityType === 'order_detail' || entity.entityType === 'detail') {
    const label = detailLabel(entity.entityId, entity.detailNumber);
    return omitType ? label.replace(/^Деталь\s+/, '') : label;
  }
  const cleanName = entity.entityName?.trim();
  if (omitType) return cleanName ? `${cleanName} (#${entity.entityId})` : `#${entity.entityId}`;
  return cleanName
    ? `${entityTypeLabel(entity.entityType)} ${cleanName} (#${entity.entityId})`
    : `${entityTypeLabel(entity.entityType)} #${entity.entityId}`;
}

function selectFilterOption(input: string, option?: { label?: React.ReactNode; value?: unknown }): boolean {
  const haystack = `${option?.label ?? ''} ${option?.value ?? ''}`.toLocaleLowerCase('ru-RU');
  return haystack.includes(input.toLocaleLowerCase('ru-RU'));
}

function JsonCell({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span style={{ color: '#bfbfbf' }}>—</span>;
  return (
    <pre
      style={{
        margin: 0,
        fontSize: 11,
        maxHeight: 200,
        overflowY: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        background: '#f6f8fa',
        padding: '4px 6px',
        borderRadius: 4,
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function buildAuditQuery(
  values: FilterValues,
  pageSize: number,
  scope: AuditLogListQuery['scope'] = 'all',
): AuditLogListQuery {
  const next: AuditLogListQuery = { page: 1, pageSize };
  if (scope && scope !== 'all') next.scope = scope;
  if (values.event) next.event = values.event;
  if (values.events && values.events.length > 0) next.events = values.events;
  if (values.entityType) next.entityType = values.entityType;
  if (values.entityId) next.entityId = values.entityId;
  if (values.userId != null) next.userId = values.userId;
  if (values.orderIds && values.orderIds.length > 0) next.orderIds = values.orderIds;
  if (values.participantUserIds && values.participantUserIds.length > 0) {
    next.participantUserIds = values.participantUserIds;
  }
  if (values.role) next.role = values.role;
  if (values.source) next.source = values.source;
  if (values.relatedOrderId != null) next.relatedOrderId = values.relatedOrderId;
  if (values.relatedClientId != null) next.relatedClientId = values.relatedClientId;
  if (values.relatedPaymentId != null) next.relatedPaymentId = values.relatedPaymentId;
  if (values.relatedDeadlineId != null) next.relatedDeadlineId = values.relatedDeadlineId;
  if (values.relatedProductionEventId != null) next.relatedProductionEventId = values.relatedProductionEventId;
  if (values.relatedUserId != null) next.relatedUserId = values.relatedUserId;
  if (values.relatedEntityType) next.relatedEntityType = values.relatedEntityType;
  if (values.relatedEntityId != null) next.relatedEntityId = values.relatedEntityId;
  if (values.requestId) next.requestId = values.requestId;
  if (values.createdRange?.[0]) next.createdFrom = values.createdRange[0].toISOString();
  if (values.createdRange?.[1]) next.createdTo = values.createdRange[1].toISOString();
  if (!values.createdRange?.[0] && values.createdFrom) next.createdFrom = values.createdFrom.toISOString();
  if (!values.createdRange?.[1] && values.createdTo) next.createdTo = values.createdTo.toISOString();
  return next;
}

export function isRowExpandable(record: AuditLogEventDto): boolean {
  return (
    record.before !== null ||
    record.after !== null ||
    record.diff !== null ||
    record.metadata !== null ||
    record.statusField !== null ||
    record.statusId !== null ||
    record.statusName !== null ||
    record.statusCode !== null ||
    record.stageCode !== null ||
    record.ip !== null ||
    record.userAgent !== null
  );
}

export function RelatedIds({ record }: { record: AuditLogEventDto }) {
  const parts: React.ReactNode[] = [];
  if (record.relatedOrderId != null)
    parts.push(
      <Tag key="order" color="blue">
        {orderLabel(record.relatedOrderId, record.relatedOrderName)}
      </Tag>
    );
  if (record.relatedClientId != null)
    parts.push(
      <Tag key="client" color="geekblue">
        {clientLabel(record.relatedClientId, record.relatedClientName)}
      </Tag>
    );
  if (record.relatedPaymentId != null)
    parts.push(
      <Tag key="payment" color="green">
        Платёж #{record.relatedPaymentId}
      </Tag>
    );
  if (record.relatedDeadlineId != null)
    parts.push(
      <Tag key="deadline" color="orange">
        Дедлайн #{record.relatedDeadlineId}
      </Tag>
    );
  if (record.relatedProductionEventId != null)
    parts.push(
      <Tag key="prod" color="purple">
        Произв. #{record.relatedProductionEventId}
      </Tag>
    );
  if (record.relatedUserId != null)
    parts.push(
      <Tag key="user" color="cyan">
        Пользователь #{record.relatedUserId}
      </Tag>
    );
  if (Array.isArray(record.relatedEntities)) {
    for (const e of record.relatedEntities) {
      parts.push(
        <Tag key={`re-${e.entityType}-${e.entityId}`} color="magenta">
          {relatedEntityLabel(e)}
        </Tag>
      );
    }
  }
  if (parts.length === 0) return <span style={{ color: '#bfbfbf' }}>—</span>;
  return <>{parts}</>;
}

function ContextRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div style={{ fontSize: 11, lineHeight: '16px' }}>
      <Text type="secondary">{label}: </Text>
      <Text style={{ fontSize: 11, wordBreak: 'break-all' }}>{value}</Text>
    </div>
  );
}

export function ContextBlock({ record }: { record: AuditLogEventDto }) {
  const hasStatus =
    record.statusField != null ||
    record.statusId != null ||
    record.statusName != null ||
    record.statusCode != null ||
    record.stageCode != null;
  if (!hasStatus && record.ip == null && record.userAgent == null) return null;
  return (
    <div style={{ flex: '1 1 220px', minWidth: 220 }}>
      <Text strong style={{ fontSize: 12 }}>
        контекст
      </Text>
      <div style={{ marginTop: 2 }}>
        <ContextRow label="status_field" value={record.statusField} />
        <ContextRow label="status_id" value={record.statusId} />
        <ContextRow label="status_name" value={record.statusName} />
        <ContextRow label="status_code" value={record.statusCode} />
        <ContextRow label="stage_code" value={record.stageCode} />
        <ContextRow label="ip" value={record.ip} />
        <ContextRow label="user_agent" value={record.userAgent} />
      </div>
    </div>
  );
}

export function ReadableAuditEvent({ record }: { record: AuditLogEventDto }) {
  const summary = buildAuditReadableSummary(record);

  return (
    <div style={{ maxWidth: 820 }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Text strong>{summary.title}</Text>
        <div>
          <Text type="secondary">Кем: </Text>
          <Text>{summary.actor}</Text>
          <Text type="secondary"> · Объект: </Text>
          <Text>{summary.object}</Text>
        </div>
        {summary.changes.map((change) => (
          <div key={`${change.label}-${change.before}-${change.after}`}>
            <Text>{change.label}: </Text>
            <Text>{change.before}</Text>
            <Text type="secondary"> → </Text>
            <Text>{change.after}</Text>
          </div>
        ))}
        {(summary.related.length > 0 || summary.notes.length > 0) && (
          <Space size={[4, 4]} wrap>
            {summary.related.map((item) => (
              <Tag key={`related-${item}`} color="blue">
                {item}
              </Tag>
            ))}
            {summary.notes.map((note) => (
              <Tag key={`note-${note}`} color="default">
                {note}
              </Tag>
            ))}
          </Space>
        )}
      </Space>
    </div>
  );
}

export interface HistoryJournalTableProps {
  mode?: AuditTableMode;
  embedded?: boolean;
  title?: string;
  defaultFiltersVisible?: boolean;
}

export const HistoryJournalTable: React.FC<HistoryJournalTableProps> = ({
  mode = 'audit',
  embedded = false,
  title,
  defaultFiltersVisible = false,
}) => {
  const businessHistoryMode = mode === 'business-history';
  const resolvedTitle = title ?? (businessHistoryMode ? 'История бизнеса' : 'Технический аудит');
  const [form] = Form.useForm<FilterValues>();
  const [filtersVisible, setFiltersVisible] = useState(defaultFiltersVisible);
  const [viewMode, setViewMode] = useState<AuditViewMode>('readable');
  const { pageSize: preferredPageSize, setPageSize: rememberPageSize } = usePageSizePreference(
    businessHistoryMode ? 'history-journal:list' : 'audit:list',
    PAGE_SIZE_DEFAULT
  );
  const [query, setQuery] = useState<AuditLogListQuery>({
    page: 1,
    pageSize: preferredPageSize,
    ...(businessHistoryMode ? { scope: 'business' as const } : {}),
  });
  const [data, setData] = useState<AuditLogEventDto[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    pageSize: PAGE_SIZE_DEFAULT,
    total: 0,
  });
  const [loading, setLoading] = useState(false);
  const [filterOptions, setFilterOptions] = useState<AuditFilterOptions>(EMPTY_FILTER_OPTIONS);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const [filterOptionsLoaded, setFilterOptionsLoaded] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [orderOptions, setOrderOptions] = useState<AuditOrderFilterOption[]>([]);
  const [participantOptions, setParticipantOptions] = useState<AuditParticipantFilterOption[]>([]);
  const [orderOptionsLoading, setOrderOptionsLoading] = useState(false);
  const [participantOptionsLoading, setParticipantOptionsLoading] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const filterOptionsAbortRef = useRef<AbortController | null>(null);
  const orderOptionsSeqRef = useRef(0);
  const participantOptionsSeqRef = useRef(0);
  const orderSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const participantSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const relatedEntityType = Form.useWatch('relatedEntityType', form);

  // Permission check: audit.view is required when backend permissions are on
  const currentUser = featureFlags.useBackendPermissions ? authSession.getUser() : null;
  const hasPermission = !featureFlags.useBackendPermissions || can('audit.view', currentUser);

  const fetchData = useCallback(
    async (q: AuditLogListQuery) => {
      if (!hasPermission) return;

      abortRef.current?.abort();
      abortRef.current = new AbortController();

      setLoading(true);
      setPermissionError(null);

      try {
        const response = await auditApi.list(q);
        setData(response.data);
        setPagination({
          page: response.pagination.page,
          pageSize: response.pagination.pageSize,
          total: response.pagination.total,
        });
      } catch (err) {
        if (err instanceof ApiError && (err.statusCode === 403 || err.statusCode === 401)) {
          setPermissionError('Недостаточно прав для просмотра журналов (audit.view).');
          setData([]);
        } else if (err instanceof Error && err.name !== 'AbortError') {
          setPermissionError(`Ошибка загрузки: ${err.message}`);
          setData([]);
        }
      } finally {
        setLoading(false);
      }
    },
    [hasPermission]
  );

  const fetchFilterOptions = useCallback(async () => {
    if (!hasPermission) return;

    filterOptionsAbortRef.current?.abort();
    filterOptionsAbortRef.current = new AbortController();
    setFilterOptionsLoading(true);

    try {
      const response = await auditApi.filterOptions(businessHistoryMode ? { scope: 'business' } : {});
      setFilterOptions(response.data);
      setFilterOptionsLoaded(true);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setFilterOptionsLoaded(true);
      if (err instanceof ApiError && (err.statusCode === 403 || err.statusCode === 401)) {
        setPermissionError('Недостаточно прав для просмотра журналов (audit.view).');
      } else if (err instanceof Error) {
        setPermissionError(`Ошибка загрузки фильтров: ${err.message}`);
      }
    } finally {
      setFilterOptionsLoading(false);
    }
  }, [businessHistoryMode, hasPermission]);

  const fetchOrderOptions = useCallback(
    async (search?: string) => {
      if (!hasPermission || !businessHistoryMode) return;
      const seq = ++orderOptionsSeqRef.current;
      setOrderOptionsLoading(true);
      try {
        const selectedIds = form.getFieldValue('orderIds') as number[] | undefined;
        const response = await auditApi.orderOptions({ search, ids: selectedIds, limit: 50 });
        if (orderOptionsSeqRef.current === seq) setOrderOptions(response.data);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') setOrderOptions([]);
      } finally {
        if (orderOptionsSeqRef.current === seq) setOrderOptionsLoading(false);
      }
    },
    [businessHistoryMode, form, hasPermission],
  );

  const fetchParticipantOptions = useCallback(
    async (search?: string) => {
      if (!hasPermission || !businessHistoryMode) return;
      const seq = ++participantOptionsSeqRef.current;
      setParticipantOptionsLoading(true);
      try {
        const selectedIds = form.getFieldValue('participantUserIds') as number[] | undefined;
        const response = await auditApi.participantOptions({ search, ids: selectedIds, limit: 50 });
        if (participantOptionsSeqRef.current === seq) setParticipantOptions(response.data);
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') setParticipantOptions([]);
      } finally {
        if (participantOptionsSeqRef.current === seq) setParticipantOptionsLoading(false);
      }
    },
    [businessHistoryMode, form, hasPermission],
  );

  const scheduleOrderSearch = useCallback((value: string) => {
    if (orderSearchTimerRef.current) clearTimeout(orderSearchTimerRef.current);
    orderSearchTimerRef.current = setTimeout(() => {
      void fetchOrderOptions(value);
    }, 250);
  }, [fetchOrderOptions]);

  const scheduleParticipantSearch = useCallback((value: string) => {
    if (participantSearchTimerRef.current) clearTimeout(participantSearchTimerRef.current);
    participantSearchTimerRef.current = setTimeout(() => {
      void fetchParticipantOptions(value);
    }, 250);
  }, [fetchParticipantOptions]);

  useEffect(() => {
    void fetchData(query);
  }, [query, fetchData]);

  useEffect(() => {
    if (!filtersVisible || filterOptionsLoaded || filterOptionsLoading) return;
    void fetchFilterOptions();
  }, [fetchFilterOptions, filterOptionsLoaded, filterOptionsLoading, filtersVisible]);

  useEffect(() => {
    if (!filtersVisible || !businessHistoryMode) return;
    void fetchOrderOptions();
    void fetchParticipantOptions();
  }, [businessHistoryMode, fetchOrderOptions, fetchParticipantOptions, filtersVisible]);

  useEffect(() => () => {
    if (orderSearchTimerRef.current) clearTimeout(orderSearchTimerRef.current);
    if (participantSearchTimerRef.current) clearTimeout(participantSearchTimerRef.current);
  }, []);

  useEffect(() => {
    setQuery((current) =>
      current.pageSize === preferredPageSize ? current : { ...current, page: 1, pageSize: preferredPageSize }
    );
  }, [preferredPageSize]);

  const handleFilter = (values: FilterValues) => {
    setQuery(buildAuditQuery(values, query.pageSize ?? PAGE_SIZE_DEFAULT, businessHistoryMode ? 'business' : 'all'));
  };

  const handleClearFilters = () => {
    form.resetFields();
    setQuery({
      page: 1,
      pageSize: query.pageSize ?? PAGE_SIZE_DEFAULT,
      ...(businessHistoryMode ? { scope: 'business' as const } : {}),
    });
  };

  const handleTableChange = (pag: { current?: number; pageSize?: number }) => {
    const nextPageSize = pag.pageSize ?? query.pageSize ?? PAGE_SIZE_DEFAULT;
    const pageSizeChanged = nextPageSize !== query.pageSize;
    if (pageSizeChanged) rememberPageSize(nextPageSize);
    setQuery((prev) => ({
      ...prev,
      page: pageSizeChanged ? 1 : pag.current ?? 1,
      pageSize: nextPageSize,
    }));
  };

  const filterSelectOptions = useMemo(
    () => ({
      events: stringSelectOptions(filterOptions.events),
      entityTypes: stringSelectOptions(filterOptions.entityTypes),
      entityIds: stringSelectOptions(filterOptions.entityIds),
      users: userSelectOptions(filterOptions.users),
      roles: stringSelectOptions(filterOptions.roles),
      sources: stringSelectOptions(filterOptions.sources),
      relatedOrderIds: numberSelectOptions(filterOptions.relatedOrderIds, 'Заказ'),
      relatedClientIds: numberSelectOptions(filterOptions.relatedClientIds, 'Клиент'),
      relatedPaymentIds: numberSelectOptions(filterOptions.relatedPaymentIds, 'Платёж'),
      relatedDeadlineIds: numberSelectOptions(filterOptions.relatedDeadlineIds, 'Дедлайн'),
      relatedProductionEventIds: numberSelectOptions(filterOptions.relatedProductionEventIds, 'Произв. событие'),
      relatedUserIds: numberSelectOptions(filterOptions.relatedUserIds, 'Пользователь'),
      relatedEntityTypes: stringSelectOptions(filterOptions.relatedEntityTypes),
      relatedEntityIds: relatedEntityIdSelectOptions(filterOptions.relatedEntities, relatedEntityType),
      requestIds: stringSelectOptions(filterOptions.requestIds),
      orderLookups: orderLookupSelectOptions(orderOptions),
      participantLookups: participantLookupSelectOptions(participantOptions),
    }),
    [filterOptions, orderOptions, participantOptions, relatedEntityType]
  );

  const commonSelectProps = {
    allowClear: true,
    showSearch: true,
    size: 'small' as const,
    loading: filterOptionsLoading,
    optionFilterProp: 'label',
    filterOption: selectFilterOption,
  };

  const expandedRowRender = (record: AuditLogEventDto) => (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <ContextBlock record={record} />
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>
          before
        </Text>
        <JsonCell value={record.before} />
      </div>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>
          after
        </Text>
        <JsonCell value={record.after} />
      </div>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>
          diff
        </Text>
        <JsonCell value={record.diff} />
      </div>
      <div style={{ flex: '1 1 220px', minWidth: 220 }}>
        <Text strong style={{ fontSize: 12 }}>
          metadata
        </Text>
        <JsonCell value={record.metadata} />
      </div>
    </div>
  );

  if (!hasPermission) {
    return (
      <div style={{ padding: embedded ? 0 : 32 }}>
        <Alert
          type="warning"
          showIcon
          message="Доступ запрещён"
          description="У вас нет разрешения audit.view для просмотра журнала аудита."
        />
      </div>
    );
  }

  return (
    <div style={{ padding: embedded ? 0 : '16px 24px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <Space>
          <AuditOutlined style={{ fontSize: 18, color: '#1677ff' }} />
          <Text strong style={{ fontSize: 16 }}>
            {resolvedTitle}
          </Text>
        </Space>
        <Space size="small" wrap>
          {!businessHistoryMode && (
            <Segmented
              size="small"
              value={viewMode}
              options={[
                { label: 'Понятный', value: 'readable' },
                { label: 'Технический', value: 'technical' },
              ]}
              onChange={(value) => setViewMode(value as AuditViewMode)}
            />
          )}
          <Button
            type={filtersVisible ? 'primary' : 'default'}
            icon={<FilterOutlined />}
            onClick={() => setFiltersVisible((v) => !v)}
            size="small"
          >
            {filtersVisible ? 'Скрыть фильтры' : 'Фильтры'}
          </Button>
        </Space>
      </div>

      {permissionError && <Alert type="error" showIcon message={permissionError} style={{ marginBottom: 12 }} />}

      {filtersVisible && (
        <Card size="small" style={{ marginBottom: 12 }} bodyStyle={{ padding: '8px 12px' }}>
          <style>{`
            .audit-filters .ant-form-item { margin-bottom: 6px; }
            .audit-filters .ant-form-item-label > label { font-size: 11px; }
            .audit-filters-grid { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-end; }
            .audit-filters-grid > .aff-item { flex-shrink: 0; }
          `}</style>
          <Form form={form} layout="vertical" onFinish={handleFilter} className="audit-filters">
            {businessHistoryMode ? (
              <div className="audit-filters-grid">
                <div className="aff-item">
                  <Form.Item name="createdRange" label="Период">
                    <DatePicker.RangePicker
                      showTime
                      allowClear
                      format="DD.MM.YYYY HH:mm:ss"
                      size="small"
                      style={{ width: 330 }}
                    />
                  </Form.Item>
                </div>
                <div className="aff-item">
                  <Form.Item name="events" label="События">
                    <Select
                      {...commonSelectProps}
                      mode="multiple"
                      placeholder="События"
                      options={filterSelectOptions.events}
                      maxTagCount="responsive"
                      style={{ width: 260 }}
                    />
                  </Form.Item>
                </div>
                <div className="aff-item">
                  <Form.Item name="orderIds" label="Заказы">
                    <Select
                      allowClear
                      showSearch
                      mode="multiple"
                      size="small"
                      loading={orderOptionsLoading}
                      filterOption={false}
                      onSearch={scheduleOrderSearch}
                      onFocus={() => fetchOrderOptions()}
                      placeholder="Заказы"
                      options={filterSelectOptions.orderLookups}
                      maxTagCount="responsive"
                      style={{ width: 260 }}
                    />
                  </Form.Item>
                </div>
                <div className="aff-item">
                  <Form.Item name="participantUserIds" label="Участники">
                    <Select
                      allowClear
                      showSearch
                      mode="multiple"
                      size="small"
                      loading={participantOptionsLoading}
                      filterOption={false}
                      onSearch={scheduleParticipantSearch}
                      onFocus={() => fetchParticipantOptions()}
                      placeholder="Участники"
                      options={filterSelectOptions.participantLookups}
                      maxTagCount="responsive"
                      style={{ width: 260 }}
                    />
                  </Form.Item>
                </div>
                <div className="aff-item">
                  <Form.Item label=" " colon={false}>
                    <Space size="small">
                      <Button type="primary" htmlType="submit" icon={<FilterOutlined />} size="small">
                        Применить
                      </Button>
                      <Button onClick={handleClearFilters} icon={<ClearOutlined />} size="small">
                        Сбросить
                      </Button>
                    </Space>
                  </Form.Item>
                </div>
              </div>
            ) : (
            <div className="audit-filters-grid">
              <div className="aff-item">
                <Form.Item name="event" label="Событие">
                  <Select
                    {...commonSelectProps}
                    placeholder="Событие"
                    options={filterSelectOptions.events}
                    style={{ width: 190 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="entityType" label="Тип сущности">
                  <Select
                    {...commonSelectProps}
                    placeholder="Тип"
                    options={filterSelectOptions.entityTypes}
                    style={{ width: 130 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="entityId" label="ID сущности">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.entityIds}
                    style={{ width: 110 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="userId" label="ID пользователя">
                  <Select
                    {...commonSelectProps}
                    placeholder="Пользователь"
                    options={filterSelectOptions.users}
                    style={{ width: 170 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="role" label="Роль">
                  <Select
                    {...commonSelectProps}
                    placeholder="Роль"
                    options={filterSelectOptions.roles}
                    style={{ width: 120 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="source" label="Источник">
                  <Select
                    {...commonSelectProps}
                    placeholder="Источник"
                    options={filterSelectOptions.sources}
                    style={{ width: 180 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedOrderId" label="Заказ #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedOrderIds}
                    style={{ width: 120 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedClientId" label="Клиент #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedClientIds}
                    style={{ width: 120 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedPaymentId" label="Платёж #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedPaymentIds}
                    style={{ width: 120 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedDeadlineId" label="Дедлайн #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedDeadlineIds}
                    style={{ width: 120 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedProductionEventId" label="Произв. событие #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedProductionEventIds}
                    style={{ width: 150 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedUserId" label="Пользователь #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedUserIds}
                    style={{ width: 140 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedEntityType" label="Related тип">
                  <Select
                    {...commonSelectProps}
                    placeholder="Тип"
                    options={filterSelectOptions.relatedEntityTypes}
                    style={{ width: 150 }}
                    onChange={() => form.setFieldValue('relatedEntityId', undefined)}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="relatedEntityId" label="Related #">
                  <Select
                    {...commonSelectProps}
                    placeholder="ID"
                    options={filterSelectOptions.relatedEntityIds}
                    style={{ width: 130 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="requestId" label="Request ID">
                  <Select
                    {...commonSelectProps}
                    placeholder="Request ID"
                    options={filterSelectOptions.requestIds}
                    style={{ width: 190 }}
                  />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="createdFrom" label="Дата с">
                  <DatePicker showTime allowClear format="DD.MM.YYYY HH:mm:ss" size="small" style={{ width: 180 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item name="createdTo" label="Дата по">
                  <DatePicker showTime allowClear format="DD.MM.YYYY HH:mm:ss" size="small" style={{ width: 180 }} />
                </Form.Item>
              </div>
              <div className="aff-item">
                <Form.Item label=" " colon={false}>
                  <Space size="small">
                    <Button type="primary" htmlType="submit" icon={<FilterOutlined />} size="small">
                      Применить
                    </Button>
                    <Button onClick={handleClearFilters} icon={<ClearOutlined />} size="small">
                      Сбросить
                    </Button>
                  </Space>
                </Form.Item>
              </div>
            </div>
            )}
          </Form>
        </Card>
      )}

      {businessHistoryMode || viewMode === 'readable' ? (
        <Table<AuditLogEventDto>
          rowKey="auditId"
          loading={loading}
          dataSource={data}
          size="small"
          sticky
          scroll={{ x: 'max-content', y: 600 }}
          pagination={{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showSizeChanger: true,
            showTotal: (total) => `Всего: ${total}`,
          }}
          onChange={(pag) => handleTableChange(pag)}
          locale={{ emptyText: <Empty description={businessHistoryMode ? 'Нет записей истории бизнеса' : 'Нет записей аудита'} /> }}
        >
          <Table.Column<AuditLogEventDto>
            dataIndex="createdAt"
            title="Когда"
            width={150}
            render={(value) => formatDateTime(value)}
          />
          <Table.Column<AuditLogEventDto>
            title="Описание"
            width={760}
            render={(_, record) => <ReadableAuditEvent record={record} />}
          />
        </Table>
      ) : (
        <Table<AuditLogEventDto>
          rowKey="auditId"
          loading={loading}
          dataSource={data}
          size="small"
          sticky
          scroll={{ x: 'max-content', y: 600 }}
          pagination={{
            current: pagination.page,
            pageSize: pagination.pageSize,
            total: pagination.total,
            pageSizeOptions: PAGE_SIZE_OPTIONS,
            showSizeChanger: true,
            showTotal: (total) => `Всего: ${total}`,
          }}
          onChange={(pag) => handleTableChange(pag)}
          expandable={{
            expandedRowRender,
            rowExpandable: isRowExpandable,
          }}
          locale={{ emptyText: <Empty description="Нет записей аудита" /> }}
        >
          <Table.Column<AuditLogEventDto>
            dataIndex="createdAt"
            title="Дата/время"
            width={150}
            render={(value) => formatDateTime(value)}
          />
          <Table.Column<AuditLogEventDto>
            dataIndex="event"
            title="Событие"
            width={180}
            ellipsis
            render={(value: string) => <Tag color="blue">{value}</Tag>}
          />
          <Table.Column<AuditLogEventDto>
            title="Актор"
            width={140}
            render={(_, record) => {
              if (!record.username) return <span style={{ color: '#bfbfbf' }}>—</span>;
              return (
                <div>
                  <div>{record.username}</div>
                  {record.role && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {record.role}
                    </Text>
                  )}
                </div>
              );
            }}
          />
          <Table.Column<AuditLogEventDto>
            title="Сущность"
            width={130}
            render={(_, record) => (
              <div>
                <Text style={{ fontSize: 12 }}>{record.entityType ?? <span style={{ color: '#bfbfbf' }}>—</span>}</Text>
                {record.entityId && (
                  <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                    #{record.entityId}
                  </Text>
                )}
              </div>
            )}
          />
          <Table.Column<AuditLogEventDto>
            title="Связанные объекты"
            width={220}
            render={(_, record) => <RelatedIds record={record} />}
          />
          <Table.Column<AuditLogEventDto>
            dataIndex="source"
            title="Источник"
            width={90}
            render={(value: string | null) => value ?? <span style={{ color: '#bfbfbf' }}>—</span>}
          />
          <Table.Column<AuditLogEventDto>
            dataIndex="requestId"
            title="Request ID"
            width={130}
            ellipsis
            render={(value: string) =>
              value ? (
                <Tooltip title={value}>
                  <Text code style={{ fontSize: 11 }}>
                    {value.slice(0, 8)}…
                  </Text>
                </Tooltip>
              ) : (
                <span style={{ color: '#bfbfbf' }}>—</span>
              )
            }
          />
        </Table>
      )}
    </div>
  );
};

export const AuditList: React.FC = () => (
  <div style={{ padding: '8px 16px 0' }}>
    <style>{`
      .journals-top-tabs .ant-tabs-tab,
      .technical-audit-tabs .ant-tabs-tab { min-height: 40px; font-weight: 600; }
    `}</style>
    <Tabs
      className="journals-top-tabs"
      defaultActiveKey="business-history"
      items={[
        {
          key: 'business-history',
          label: 'История бизнеса',
          children: (
            <HistoryJournalTable
              mode="business-history"
              embedded
              title="История бизнеса"
              defaultFiltersVisible
            />
          ),
        },
        {
          key: 'technical-audit',
          label: 'Технический аудит',
          children: (
            <Tabs
              className="technical-audit-tabs"
              defaultActiveKey="erp"
              items={[
                { key: 'erp', label: 'Действия ERP', children: <HistoryJournalTable embedded title="Действия ERP" /> },
                { key: 'telegram', label: 'Telegram-бот', children: <TelegramWorkerAudit /> },
              ]}
            />
          ),
        },
      ]}
    />
  </div>
);
