import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { IResourceComponentsProps } from '@refinedev/core';
import { ReloadOutlined } from '@ant-design/icons';
import { Alert, Button, DatePicker, Input, Space, Table, Tag, Typography } from 'antd';
import type { Dayjs } from 'dayjs';
import { Link } from 'react-router-dom';
import {
  ordersApi,
  subscribeOrderDataChanged,
} from '../../api/ordersApi';
import type {
  OrderFilmDemandDto,
  OrderResourceDemandQuery,
  OrderResourceDemandResponse,
  OrderSheetMaterialDemandDto,
} from '../../api/types/orderApi.types';
import { LocalizedList } from '../../components/LocalizedList';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import { subscribeCutJobReady } from '../cut/cutJobEvents';

const LIVE_REFRESH_INTERVAL_MS = 5_000;
const numberFormatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const meterFormatter = new Intl.NumberFormat('ru-RU', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const numericStyle = { fontVariantNumeric: 'tabular-nums' } as const;

type DateRange = [Dayjs | null, Dayjs | null] | null;

export const OrderResourceRequirementList: React.FC<IResourceComponentsProps> = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const deferredSearch = useDeferredValue(searchInput.trim());
  const query = useMemo<OrderResourceDemandQuery>(() => ({
    page,
    pageSize,
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(dateRange?.[0] ? { dateFrom: dateRange[0].format('YYYY-MM-DD') } : {}),
    ...(dateRange?.[1] ? { dateTo: dateRange[1].format('YYYY-MM-DD') } : {}),
  }), [dateRange, deferredSearch, page, pageSize]);
  const { response, loading, error } = useLiveOrderResourceDemands(query, refreshRevision);

  const resetPage = () => setPage(1);

  return (
    <LocalizedList title="Потребности заказов в ресурсах">
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap size={8}>
          <Input.Search
            allowClear
            aria-label="Поиск заказа"
            placeholder="Номер заказа или клиент"
            value={searchInput}
            onChange={(event) => {
              setSearchInput(event.target.value);
              resetPage();
            }}
            style={{ width: 280 }}
          />
          <DatePicker.RangePicker
            allowClear
            value={dateRange}
            format="DD.MM.YYYY"
            placeholder={['Заказы с даты', 'Заказы по дату']}
            onChange={(value) => {
              setDateRange(value ? [value[0], value[1]] : null);
              resetPage();
            }}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={loading && Boolean(response)}
            onClick={() => setRefreshRevision((value) => value + 1)}
          >
            Обновить
          </Button>
          <Tag color="green">Обновление каждые 5 секунд</Tag>
          {response?.refreshedAt && (
            <Typography.Text type="secondary" style={numericStyle}>
              Данные на {formatDateTime(response.refreshedAt)}
            </Typography.Text>
          )}
        </Space>

        {error && (
          <Alert
            showIcon
            type="error"
            message="Не удалось обновить потребности"
            description={error}
          />
        )}

        <Table
          rowKey="orderId"
          dataSource={response?.data ?? []}
          loading={loading && !response}
          scroll={{ x: 1080 }}
          pagination={{
            current: response?.pagination.page ?? page,
            pageSize: response?.pagination.pageSize ?? pageSize,
            total: response?.pagination.total ?? 0,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total) => `Заказов: ${total}`,
            onChange: (nextPage, nextPageSize) => {
              setPage(nextPageSize === pageSize ? nextPage : 1);
              setPageSize(nextPageSize);
            },
          }}
          locale={{ emptyText: 'Заказы по выбранным условиям не найдены' }}
        >
          <Table.Column
            key="order"
            title="Заказ"
            width={230}
            render={(_, row: OrderResourceDemandResponse['data'][number]) => (
              <Space direction="vertical" size={0}>
                <Link to={`/orders/show/${row.orderId}`}>{row.fullNumber}</Link>
                <Typography.Text type="secondary">
                  {row.clientName || 'Клиент не указан'}
                </Typography.Text>
              </Space>
            )}
          />
          <Table.Column
            key="date"
            title="Дата заказа"
            width={125}
            render={(_, row: OrderResourceDemandResponse['data'][number]) => (
              <span style={numericStyle}>{row.orderDate ? formatDate(row.orderDate) : '—'}</span>
            )}
          />
          <Table.Column
            key="sheetMaterials"
            title="Листовые материалы"
            width={360}
            render={(_, row: OrderResourceDemandResponse['data'][number]) => (
              <SheetMaterialCell rows={row.sheetMaterials} />
            )}
          />
          <Table.Column
            key="films"
            title="Плёнка"
            width={360}
            render={(_, row: OrderResourceDemandResponse['data'][number]) => (
              <FilmCell rows={row.films} />
            )}
          />
        </Table>
      </Space>
    </LocalizedList>
  );
};

function SheetMaterialCell({ rows }: { rows: OrderSheetMaterialDemandDto[] }) {
  if (rows.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const totalArea = rows.reduce((sum, row) => sum + row.totalArea, 0);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {rows.map((row) => (
        <ResourceLine
          key={row.sheetMaterialTypeId}
          name={row.name}
          provider={row.supplierName ? `Поставщик: ${row.supplierName}` : null}
          quantity={`${numberFormatter.format(row.totalArea)} м²`}
          detailsCount={row.detailsCount}
        />
      ))}
      {rows.length > 1 && (
        <Typography.Text strong style={numericStyle}>
          Итого: {numberFormatter.format(totalArea)} м²
        </Typography.Text>
      )}
    </Space>
  );
}

function FilmCell({ rows }: { rows: OrderFilmDemandDto[] }) {
  if (rows.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const totalMeters = rows.reduce((sum, row) => sum + row.linearMeters, 0);
  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      {rows.map((row) => (
        <ResourceLine
          key={row.filmId}
          name={row.name}
          provider={row.vendorName ? `Производитель: ${row.vendorName}` : null}
          quantity={row.hasCutData ? `${meterFormatter.format(row.linearMeters)} пог. м` : 'Нет готового раскроя'}
          detailsCount={row.detailsCount}
          secondaryQuantity={`${numberFormatter.format(row.totalArea)} м²`}
        />
      ))}
      {rows.length > 1 && totalMeters > 0 && (
        <Typography.Text strong style={numericStyle}>
          Итого: {meterFormatter.format(totalMeters)} пог. м
        </Typography.Text>
      )}
    </Space>
  );
}

function ResourceLine({
  name,
  provider,
  quantity,
  detailsCount,
  secondaryQuantity,
}: {
  name: string;
  provider: string | null;
  quantity: string;
  detailsCount: number;
  secondaryQuantity?: string;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', columnGap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <Typography.Text>{name}</Typography.Text>
        {(provider || secondaryQuantity) && (
          <div>
            <Typography.Text type="secondary">
              {[provider, secondaryQuantity].filter(Boolean).join(' · ')}
            </Typography.Text>
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Typography.Text strong style={numericStyle}>{quantity}</Typography.Text>
        <div>
          <Typography.Text type="secondary" style={numericStyle}>
            Позиций: {detailsCount}
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}

function useLiveOrderResourceDemands(query: OrderResourceDemandQuery, refreshRevision: number) {
  const [response, setResponse] = useState<OrderResourceDemandResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const queryKey = JSON.stringify(query);

  useEffect(() => {
    let active = true;
    let inFlight = false;

    const load = async (silent: boolean) => {
      if (inFlight) return;
      inFlight = true;
      const requestId = requestSequence.current + 1;
      requestSequence.current = requestId;
      if (!silent) setLoading(true);
      try {
        const nextResponse = await ordersApi.listResourceDemands(query);
        if (!active || requestSequence.current !== requestId) return;
        setResponse(nextResponse);
        setError(null);
      } catch (loadError) {
        if (!active || requestSequence.current !== requestId) return;
        setError(errorMessage(loadError));
      } finally {
        inFlight = false;
        if (active && requestSequence.current === requestId) setLoading(false);
      }
    };

    void load(false);
    const interval = window.setInterval(() => void load(true), LIVE_REFRESH_INTERVAL_MS);
    const unsubscribeOrders = subscribeOrderDataChanged(() => void load(true));
    const unsubscribeCut = subscribeCutJobReady(() => void load(true));
    const onFocus = () => void load(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      active = false;
      window.clearInterval(interval);
      unsubscribeOrders();
      unsubscribeCut();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [query, queryKey, refreshRevision]);

  return { response, loading, error };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Повторите попытку или обновите страницу.';
}
