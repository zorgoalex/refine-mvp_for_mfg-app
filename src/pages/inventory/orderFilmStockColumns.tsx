import { Button, Space, Typography } from 'antd';
import { formatNumber } from '../../utils/numberFormat';
import { filmStockAvailability } from './filmStock';
import type { OrderFilmStockItem } from './useOrderFilmStock';

const { Text } = Typography;

/** Узкие колонки таблицы «Плёнка» в заказе: остаток виден без горизонтальной прокрутки. */
export const ORDER_FILM_COLUMN_WIDTH = { number: 64, sheets: 56, cutJobs: 64, stock: 84, coverage: 110 } as const;

/** Колонки остатка плёнки на складе для таблицы «Плёнка» заказа (просмотр и редактирование). */
export function orderFilmStockColumns<Row extends { filmId: number | null }>(byFilmId: ReadonlyMap<number, OrderFilmStockItem>) {
  const item = (row: Row) => (row.filmId === null ? undefined : byFilmId.get(row.filmId));
  return [
    {
      title: 'На складе, пог. м',
      key: 'stockLm',
      width: ORDER_FILM_COLUMN_WIDTH.stock,
      align: 'right' as const,
      render: (_: unknown, row: Row) => {
        const stock = item(row)?.stockLm;
        return stock == null ? '—' : <Text type={stock < 0 ? 'danger' : undefined}>{formatNumber(stock, 2)}</Text>;
      },
    },
    {
      title: 'Покрытие',
      key: 'stockStatus',
      width: ORDER_FILM_COLUMN_WIDTH.coverage,
      render: (_: unknown, row: Row) => filmStockAvailability(item(row)?.status),
    },
  ];
}

/** Подпись блока: «без резерва», время обновления и кнопка принудительного обновления. */
export function OrderFilmStockCaption(props: {
  enabled: boolean; updatedAt: string | null; isFetching: boolean; isError: boolean; refresh: () => unknown;
}) {
  return (
    <Space size={8} wrap>
      <Text type="secondary">Остаток на складе, без резерва{props.updatedAt ? ` · обновлено в ${props.updatedAt}` : ''}</Text>
      {props.enabled
        ? <Button size="small" loading={props.isFetching} onClick={() => void props.refresh()}>Обновить остатки</Button>
        : <Text type="secondary">· появится после сохранения заказа</Text>}
      {props.isError && <Text type="danger">не удалось получить остатки</Text>}
    </Space>
  );
}
