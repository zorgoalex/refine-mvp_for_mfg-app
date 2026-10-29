import { Button, Space, Typography } from 'antd';
import { formatNumber } from '../../utils/numberFormat';
import { filmStockAvailability } from './filmStock';
import type { OrderFilmStockItem } from './useOrderFilmStock';
import type { OrderSheetStockItem } from './useOrderSheetStock';
import { Tooltip } from '../../ui/tooltipDelay';

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

const SHEET_STATUS: Record<OrderSheetStockItem['status'], string> = {
  enough: 'Хватает', short: 'Не хватает', none: 'Нет на складе', unknown_demand: 'Потребность не рассчитана',
  unlinked: 'Не связан с 1С', unknown_unit: 'Единица 1С не пересчитывается', unavailable: 'Нет данных 1С',
  incomplete: 'Данные 1С неполные',
};

/** Подпись покрытия листового материала; без данных — «Нет данных». */
export const sheetStockCoverage = (status: OrderSheetStockItem['status'] | undefined): string => status ? SHEET_STATUS[status] : 'Нет данных';

/** Текст ячейки «На складе (1С)»: количество в единице 1С и, если она не м², пересчёт в м²; null — данных нет. */
export function orderSheetStockText(item: OrderSheetStockItem | undefined): string | null {
  if (!item || item.quantity === null) return null;
  const unit = item.unitName ? ` ${item.unitName}` : '';
  const m2 = item.quantityM2 !== null && item.unitName && !/м2|м²/i.test(item.unitName) ? ` ≈ ${formatNumber(item.quantityM2, 2)} м²` : '';
  return `${formatNumber(item.quantity, 3)}${unit}${m2}`;
}

/** Колонки остатка листовых материалов (данные 1С) для таблицы «Листовые материалы» заказа. */
export function orderSheetStockColumns<Row extends { sheetMaterialTypeId: number }>(byId: ReadonlyMap<number, OrderSheetStockItem>) {
  return [
    {
      title: 'На складе (1С)',
      key: 'sheetStock',
      width: ORDER_FILM_COLUMN_WIDTH.stock + 16,
      align: 'right' as const,
      render: (_: unknown, row: Row) => {
        const item = byId.get(row.sheetMaterialTypeId);
        if (!item || item.quantity === null) return '—';
        const unit = item.unitName ? ` ${item.unitName}` : '';
        const tooltip = [`1С: ${item.onecName ?? '—'}`, ...item.warehouses.map((w) => `${w.name}: ${formatNumber(w.quantity, 3)}${unit}`)].join('\n');
        return (
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{tooltip}</span>}>
            <Text type={item.quantity < 0 ? 'danger' : undefined}>{orderSheetStockText(item)}</Text>
          </Tooltip>
        );
      },
    },
    {
      title: 'Покрытие',
      key: 'sheetStockStatus',
      width: ORDER_FILM_COLUMN_WIDTH.coverage,
      render: (_: unknown, row: Row) => {
        const item = byId.get(row.sheetMaterialTypeId);
        return sheetStockCoverage(item?.status);
      },
    },
  ];
}

/** Подпись блока листовых материалов: данные 1С, дата снимка, кнопка обновления. */
export function OrderSheetStockCaption(props: {
  enabled: boolean; updatedAt: string | null; isFetching: boolean; isError: boolean; refresh: () => unknown; snapshotVersion: string | null;
  incompleteWarehouses?: Array<{ name: string }>; unsupported?: boolean;
}) {
  const snapshot = props.snapshotVersion
    ? new Date(props.snapshotVersion).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null;
  return (
    <Space size={8} wrap>
      <Text type="secondary">Остаток по данным 1С{snapshot ? ` на ${snapshot}` : ''}, без резерва{props.updatedAt ? ` · обновлено в ${props.updatedAt}` : ''}</Text>
      {props.enabled
        ? <Button size="small" loading={props.isFetching} onClick={() => void props.refresh()}>Обновить остатки</Button>
        : <Text type="secondary">· появится после сохранения заказа</Text>}
      {props.isError && <Text type="danger">не удалось получить остатки</Text>}
      {props.unsupported && <Text type="secondary">остатки листовых материалов недоступны в этой версии сервера</Text>}
      {(props.incompleteWarehouses?.length ?? 0) > 0 && <Text type="warning">нет данных 1С по складам: {props.incompleteWarehouses!.map((w) => w.name).join(', ')} — остаток неполный</Text>}
    </Space>
  );
}
