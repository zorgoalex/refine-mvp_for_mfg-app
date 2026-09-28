import type { IResourceComponentsProps } from '@refinedev/core';
import { Alert, Checkbox, DatePicker, Input, Pagination, Space, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { isApiError } from '../../api/apiError';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import type { OnecDocumentListItemDto } from '../../api/types/onecDocumentsApi.types';
import { LocalizedList } from '../../components/LocalizedList';
import { PAGE_SIZE_OPTIONS, usePageSizePreference } from '../../hooks/usePageSizePreference';
import { Segmented } from '../../ui/Segmented';
import { Table } from '../../ui/tooltipDelay';
import { formatDate } from '../../utils/dateFormat';
import {
  onecDocKindLabel,
  onecDocumentShowPath,
  onecDocumentStatusLabel,
  onecDocumentStatusTagColor,
  orderResourceRequirementsOnecFilterPath,
} from '../order_resource_requirements/onecDocKind';
import { RESOURCE_KIND_BY_KEY } from '../order_resource_requirements/resourceKinds';
import { allocationStateLabel, allocationStateTagColor, formatOnecAmount, ONEC_DOCUMENTS_TAB_OPTIONS } from './onecDocumentsHelpers';
import { useOnecDocumentsPermissions } from './onecDocumentsPermissions';

const { RangePicker } = DatePicker;
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 20;
type DateRange = [Dayjs | null, Dayjs | null] | null;

type LoadState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | {
    status: 'ready';
    data: OnecDocumentListItemDto[];
    total: number;
    amountsVisible: boolean;
  };

/**
 * Экран «Закупки → Документы 1С»: список документов поступления/оплат с
 * привязкой к заказам. До фазы 4 (ETL) таблицы пусты — показывает
 * информационное пустое состояние. Флаг выключен на backend → Alert.
 */
export const OnecPurchaseDocumentList: React.FC<IResourceComponentsProps> = () => {
  const navigate = useNavigate();
  const { canView, loading: permissionsLoading } = useOnecDocumentsPermissions();
  const [tab, setTab] = useState<'receipts' | 'payments'>('receipts');
  const [page, setPage] = useState(DEFAULT_PAGE);
  const { pageSize, setPageSize: rememberPageSize } = usePageSizePreference(
    'onec-purchase-documents:list',
    DEFAULT_PAGE_SIZE,
  );
  const [searchInput, setSearchInput] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [postedOnly, setPostedOnly] = useState(false);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  // Смена вкладки/фильтра начинает с первой страницы.
  useEffect(() => {
    setPage(DEFAULT_PAGE);
  }, [tab, searchInput, dateRange, unlinkedOnly, postedOnly]);

  useEffect(() => {
    let active = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    onecDocumentsApi.list({
      tab,
      page,
      pageSize,
      search: searchInput.trim() || undefined,
      dateFrom: dateRange?.[0]?.format('YYYY-MM-DD'),
      dateTo: dateRange?.[1]?.format('YYYY-MM-DD'),
      unlinkedOnly: unlinkedOnly || undefined,
      postedOnly: postedOnly || undefined,
    })
      .then((response) => {
        if (!active) return;
        setState({
          status: 'ready',
          data: response.data,
          total: response.pagination.total,
          amountsVisible: response.amountsVisible,
        });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isApiError(error, 'PROCUREMENT_DISABLED')) {
          setState({ status: 'disabled' });
          return;
        }
        if (isApiError(error, 'PERMISSION_DENIED') || isApiError(error, 'AUTH_REQUIRED')) {
          setState({ status: 'error', message: 'Недостаточно прав для просмотра документов 1С.' });
          return;
        }
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Не удалось загрузить документы 1С',
        });
      });
    return () => {
      active = false;
    };
  }, [tab, page, pageSize, searchInput, dateRange, unlinkedOnly, postedOnly]);

  const data = state.status === 'ready' ? state.data : EMPTY_ROWS;
  const total = state.status === 'ready' ? state.total : 0;
  const amountsVisible = state.status === 'ready' ? state.amountsVisible : false;

  const paginationConfig = useMemo(() => ({
    current: page,
    pageSize,
    total,
    showSizeChanger: false,
  }), [page, pageSize, total]);

  if (state.status === 'disabled') {
    return (
      <LocalizedList title="Документы 1С">
        <Alert showIcon type="info" message="Документы 1С пока не включены" />
      </LocalizedList>
    );
  }

  return (
    <LocalizedList title="Документы 1С">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Segmented
          aria-label="Вкладка документов 1С"
          value={tab}
          options={ONEC_DOCUMENTS_TAB_OPTIONS}
          onChange={(value) => setTab(value as 'receipts' | 'payments')}
        />
        <Space wrap>
          <Input.Search
            allowClear
            placeholder="Номер документа, контрагент"
            style={{ width: 260 }}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <RangePicker
            allowClear
            placeholder={['Документы с даты', 'по дату']}
            format="DD.MM.YYYY"
            value={dateRange}
            onChange={(value) => setDateRange(value ? [value[0], value[1]] : null)}
          />
          <Checkbox checked={unlinkedOnly} onChange={(event) => setUnlinkedOnly(event.target.checked)}>
            Только не привязанные
          </Checkbox>
          <Checkbox checked={postedOnly} onChange={(event) => setPostedOnly(event.target.checked)}>
            Только проведённые
          </Checkbox>
        </Space>

        {state.status === 'error' && (
          <Alert showIcon type="error" message="Не удалось загрузить документы 1С" description={state.message} />
        )}
        {!canView && !permissionsLoading && (
          <Alert showIcon type="warning" message="Недостаточно прав для просмотра документов 1С" />
        )}

        <Table<OnecDocumentListItemDto>
          rowKey="documentId"
          dataSource={data}
          loading={state.status === 'loading'}
          pagination={false}
          locale={{ emptyText: 'Документы появятся после подключения 1С' }}
          onRow={(record) => ({
            onClick: () => navigate(onecDocumentShowPath(record.documentId)),
            style: { cursor: 'pointer' },
          })}
        >
          <Table.Column<OnecDocumentListItemDto> key="date" title="Дата" width={110} render={(_, row) => formatDate(row.date)} />
          <Table.Column<OnecDocumentListItemDto>
            key="document"
            title="Документ"
            render={(_, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>№{row.number}</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{onecDocKindLabel(row.kind)}</Typography.Text>
              </Space>
            )}
          />
          <Table.Column<OnecDocumentListItemDto>
            key="counterparty"
            title="Поставщик / контрагент"
            render={(_, row) => row.supplierName ?? row.counterpartyName ?? '—'}
          />
          {amountsVisible && (
            <Table.Column<OnecDocumentListItemDto>
              key="amount"
              title="Сумма"
              align="right"
              render={(_, row) => formatOnecAmount(row.amount, row.currency)}
            />
          )}
          <Table.Column<OnecDocumentListItemDto>
            key="status"
            title="Статус в 1С"
            width={130}
            render={(_, row) => (
              <Tag color={onecDocumentStatusTagColor(row.posted, row.deletedInOnec)}>
                {onecDocumentStatusLabel(row.posted, row.deletedInOnec)}
              </Tag>
            )}
          />
          <Table.Column<OnecDocumentListItemDto> key="lines" title="Строк" width={80} align="right" render={(_, row) => row.linesCount} />
          <Table.Column<OnecDocumentListItemDto>
            key="orders"
            title="Для заказов"
            render={(_, row) => (
              <Space size={[4, 4]} wrap>
                {row.orders.map((order) => (
                  <Tag key={order.orderId} style={{ marginInlineEnd: 0 }}>
                    <Link
                      to={`/order-resource-requirements/show/${order.orderId}`}
                      onClick={(event) => event.stopPropagation()}
                    >
                      {order.orderName || `#${order.orderId}`}
                    </Link>
                  </Tag>
                ))}
                {row.hiddenOrdersCount > 0 && (
                  <Tag style={{ marginInlineEnd: 0 }}>ещё {row.hiddenOrdersCount} вне вашего доступа</Tag>
                )}
                {row.orders.length === 0 && row.hiddenOrdersCount === 0 && (
                  <Typography.Text type="secondary">—</Typography.Text>
                )}
                {row.orders.length > 0 && (
                  <Link
                    to={orderResourceRequirementsOnecFilterPath(row.documentId)}
                    onClick={(event) => event.stopPropagation()}
                    style={{ fontSize: 12 }}
                  >
                    в потребностях
                  </Link>
                )}
                {row.resourceKinds.map((kind) => (
                  <Tag key={kind} style={{ marginInlineEnd: 0 }} title={RESOURCE_KIND_BY_KEY[kind].label}>
                    {RESOURCE_KIND_BY_KEY[kind].letter}
                  </Tag>
                ))}
              </Space>
            )}
          />
          <Table.Column<OnecDocumentListItemDto>
            key="allocation"
            title="Привязка"
            width={140}
            render={(_, row) => (
              <Tag color={allocationStateTagColor(row.allocationState)}>{allocationStateLabel(row.allocationState)}</Tag>
            )}
          />
        </Table>

        {total > 0 && (
          <Pagination
            {...paginationConfig}
            onChange={(nextPage, nextPageSize) => {
              setPage(nextPage);
              if (nextPageSize !== pageSize) rememberPageSize(nextPageSize);
            }}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        )}
      </Space>
    </LocalizedList>
  );
};

const EMPTY_ROWS: OnecDocumentListItemDto[] = [];
