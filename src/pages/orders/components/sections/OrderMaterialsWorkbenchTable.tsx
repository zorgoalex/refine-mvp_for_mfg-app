// «NewLine»: one table for the order materials — films and sheet materials share a single
// header, every row has the same height (up to two lines per cell). Display only: the rows
// come from the same builders as the two tables of the other variants.
import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Tooltip } from '../../../../ui/tooltipDelay';
import { formatNumber } from '../../../../utils/numberFormat';
import type { CutDetailLastReadyJobRef } from '../../../../api/types/cutApi.types';
import { cutJobDeepLink, cutJobVersionLabel } from '../../cutColumnHelpers';
import type { OrderFilmMaterialRow, OrderSheetMaterialRow } from '../../orderMaterialsSummary';
import { OrderFilmStockCaption } from '../../../inventory/orderFilmStockColumns';
import { filmStockAvailability } from '../../../inventory/filmStock';
import type { OrderFilmStockItem } from '../../../inventory/useOrderFilmStock';

type BathRef = Pick<CutDetailLastReadyJobRef, 'cutJobId' | 'resultNo' | 'cutNumber' | 'name'>;

interface OrderMaterialsWorkbenchTableProps {
  filmRows: readonly OrderFilmMaterialRow[];
  sheetRows: readonly OrderSheetMaterialRow[];
  /** Bath (ванна) refs of the order details — the same refs the details list shows. */
  bathRefs: Iterable<BathRef>;
  cutJobNameById: ReadonlyMap<number, string>;
  filmStock: {
    allowed: boolean;
    byFilmId: ReadonlyMap<number, OrderFilmStockItem>;
  } & React.ComponentProps<typeof OrderFilmStockCaption>;
  filmEmptyText: string;
}

const dash = <span className="wb-materials__dash">—</span>;

export const OrderMaterialsWorkbenchTable: React.FC<OrderMaterialsWorkbenchTableProps> = ({
  filmRows,
  sheetRows,
  bathRefs,
  cutJobNameById,
  filmStock,
  filmEmptyText,
}) => {
  const bathRefById = useMemo(() => {
    const map = new Map<number, BathRef>();
    for (const ref of bathRefs) {
      if (ref && !map.has(ref.cutJobId)) map.set(ref.cutJobId, ref);
    }
    return map;
  }, [bathRefs]);
  const columnCount = filmStock.allowed ? 8 : 6;

  const renderBaths = (cutJobIds: readonly number[]) => {
    if (cutJobIds.length === 0) return dash;
    const baths = cutJobIds.map((cutJobId) => {
      const ref = bathRefById.get(cutJobId);
      const name = ref?.name?.trim() || cutJobNameById.get(cutJobId) || `#${cutJobId}`;
      return { cutJobId, name, label: ref ? cutJobVersionLabel(ref) : `#${cutJobId}`, to: ref ? cutJobDeepLink(ref) : cutJobDeepLink(cutJobId) };
    });
    return (
      <Tooltip title={<>{baths.map((bath) => <div key={bath.cutJobId}>{bath.label} · {bath.name}</div>)}</>}>
        <span className="wb-materials__baths">
          <span className="wb-materials__bath-numbers">
            {baths.map((bath, index) => (
              <React.Fragment key={bath.cutJobId}>
                {index > 0 && ', '}
                <Link to={bath.to}>{bath.label}</Link>
              </React.Fragment>
            ))}
          </span>
          <span className="wb-materials__bath-names">{baths.map((bath) => bath.name).join('; ')}</span>
        </span>
      </Tooltip>
    );
  };

  const filmTotals = filmRows.reduce(
    (sum, row) => ({
      area: sum.area + row.totalArea,
      details: sum.details + row.detailsCount,
      meters: sum.meters + row.bathLinearMeters,
      sheets: sum.sheets + row.bathSheets,
    }),
    { area: 0, details: 0, meters: 0, sheets: 0 },
  );
  const sheetTotals = sheetRows.reduce(
    (sum, row) => ({ area: sum.area + row.totalArea, details: sum.details + row.detailsCount }),
    { area: 0, details: 0 },
  );

  return (
    <div className="wb-materials">
      <table className="wb-materials__table" aria-label="Материалы заказа">
        <thead>
          <tr>
            <th>Материал</th>
            <th className="wb-materials__num">м²</th>
            <th className="wb-materials__num">Детали</th>
            <th className="wb-materials__num">Пог. м</th>
            <th className="wb-materials__num">Листы</th>
            <th>Ванны</th>
            {filmStock.allowed && <th className="wb-materials__num">На складе, пог. м</th>}
            {filmStock.allowed && <th>Склад</th>}
          </tr>
        </thead>
        <tbody>
          <tr className="wb-materials__section">
            <td colSpan={columnCount}>
              <span className="wb-materials__section-line">
                <b>Плёнка</b>
                {filmStock.allowed ? <OrderFilmStockCaption {...filmStock} /> : null}
              </span>
            </td>
          </tr>
          {filmRows.length === 0 ? (
            <tr className="wb-materials__empty"><td colSpan={columnCount}>{filmEmptyText}</td></tr>
          ) : filmRows.map((row) => {
            const stock = row.filmId === null ? undefined : filmStock.byFilmId.get(row.filmId);
            return (
              <tr key={row.key}>
                <td><span className="wb-materials__clamp" title={row.name}>{row.name}</span></td>
                <td className="wb-materials__num">{formatNumber(row.totalArea, 2)}</td>
                <td className="wb-materials__num">{row.detailsCount}</td>
                <td className="wb-materials__num">{row.bathLinearMeters > 0 ? formatNumber(row.bathLinearMeters, 1) : dash}</td>
                <td className="wb-materials__num">{row.bathSheets > 0 ? row.bathSheets : dash}</td>
                <td>{renderBaths(row.cutJobIds)}</td>
                {filmStock.allowed && (
                  <td className="wb-materials__num" data-negative={stock?.stockLm != null && stock.stockLm < 0}>
                    {stock?.stockLm == null ? dash : formatNumber(stock.stockLm, 2)}
                  </td>
                )}
                {filmStock.allowed && (
                  <td><span className="wb-materials__clamp">{filmStockAvailability(stock?.status)}</span></td>
                )}
              </tr>
            );
          })}
          {filmRows.length > 0 && (
            <tr className="wb-materials__total">
              <td>Итого плёнка</td>
              <td className="wb-materials__num">{formatNumber(filmTotals.area, 2)}</td>
              <td className="wb-materials__num">{filmTotals.details}</td>
              <td className="wb-materials__num">{filmTotals.meters > 0 ? formatNumber(filmTotals.meters, 1) : dash}</td>
              <td className="wb-materials__num">{filmTotals.sheets > 0 ? filmTotals.sheets : dash}</td>
              <td colSpan={columnCount - 5} />
            </tr>
          )}
          <tr className="wb-materials__section">
            <td colSpan={columnCount}><span className="wb-materials__section-line"><b>Листовые материалы</b></span></td>
          </tr>
          {sheetRows.length === 0 ? (
            <tr className="wb-materials__empty"><td colSpan={columnCount}>Нет данных по листовым материалам</td></tr>
          ) : sheetRows.map((row) => (
            <tr key={row.key}>
              <td><span className="wb-materials__clamp" title={row.name}>{row.name}</span></td>
              <td className="wb-materials__num">{formatNumber(row.totalArea, 2)}</td>
              <td className="wb-materials__num">{row.detailsCount}</td>
              <td colSpan={columnCount - 3} />
            </tr>
          ))}
          {sheetRows.length > 0 && (
            <tr className="wb-materials__total">
              <td>Итого листовые</td>
              <td className="wb-materials__num">{formatNumber(sheetTotals.area, 2)}</td>
              <td className="wb-materials__num">{sheetTotals.details}</td>
              <td colSpan={columnCount - 3} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
};
