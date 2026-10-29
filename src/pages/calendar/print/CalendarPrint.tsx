// «NewLine»: «Печать» of the production calendar — a dialog with the sheet preview, then the browser print
// (where «Сохранить как PDF» is too). The printed sheet is mounted into <body> only while printing.
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Modal, Space } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { Segmented } from '../../../ui/Segmented';
import { ProductionStagesDisplay } from '../../../components/ProductionStagesDisplay';
import type { CalendarFilters, CalendarOrder, ProductionWorkflowDisplay } from '../types/calendar';
import {
  areAllProductionStagesReady,
  getMaterialsForCard,
  getMillingDisplayValue,
  getStatusColor,
} from '../utils/statusColors';
import { formatDateKey } from '../utils/dateUtils';
import { useWorkbenchMaterialColor } from '../utils/workbenchMaterialColors';
import type { WorkbenchWeek } from '../utils/workbenchCalendar';
import {
  buildCalendarPrintSheets,
  CALENDAR_PRINT_MARGIN_MM,
  CALENDAR_PRINT_PAPERS,
  calendarPrintFilterLine,
  calendarPrintStamp,
  calendarPrintStats,
  ordersWord,
  type CalendarPrintPaper,
  type CalendarPrintSheet,
} from './calendarPrintModel';
import './calendarPrint.css';

const PRINTING_CLASS = 'wb-cal-printing';
const PAPER_STORAGE_KEY = 'erp.calendar.printPaper';

const readPaper = (): CalendarPrintPaper => {
  try {
    return window.localStorage.getItem(PAPER_STORAGE_KEY) === 'A3' ? 'A3' : 'A4';
  } catch {
    return 'A4';
  }
};

interface PrintCardProps {
  order: CalendarOrder;
  showFinancials: boolean;
  productionWorkflowDisplay?: ProductionWorkflowDisplay;
}

const PrintCard: React.FC<PrintCardProps> = ({ order, showFinancials, productionWorkflowDisplay }) => {
  const materialColor = useWorkbenchMaterialColor();
  const status = (order.order_status_name ?? '').toLowerCase();
  const milling = getMillingDisplayValue(order.order_details);
  const materials = getMaterialsForCard(order.order_details, true);
  const passed = order.passedProductionCodes ?? [];
  const payment = showFinancials ? order.payment_status_name ?? '' : '';
  return (
    <div
      className="wb-cal-print__card"
      data-issued={status === 'выдан' || undefined}
      data-ready={status === 'готов к выдаче' || undefined}
      style={{ ['--wb-print-stripe' as string]: getStatusColor(order.order_status_name || '') }}
    >
      <div className="wb-cal-print__card-head">
        <b className={order.order_name?.startsWith('К') ? 'wb-cal-print__number wb-cal-print__number--k' : 'wb-cal-print__number'}>
          {order.order_name}
          {order.basis_project_display ? <span> - {order.basis_project_display}</span> : null}
        </b>
        <span className="wb-cal-print__area">
          {order.total_area > 0 ? `${order.total_area.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} м²` : '0 м²'}
        </span>
      </div>
      {order.client_name ? <div className="wb-cal-print__client">{order.client_name}</div> : null}
      {milling || materials.length > 0 ? (
        <div className="wb-cal-print__facts">
          {milling ? <span>{milling}</span> : null}
          {materials.map((material) => (
            <i key={material.fullName} style={{ ['--wb-material' as string]: materialColor(material.fullName) }}>{material.name}</i>
          ))}
        </div>
      ) : null}
      {passed.length > 0 || payment ? (
        <div className="wb-cal-print__foot">
          {passed.length > 0 ? (
            <span data-ready={areAllProductionStagesReady(order) || undefined}>
              <ProductionStagesDisplay
                passedCodes={passed}
                manualCodes={order.manualProductionCodes ?? []}
                displayOrderCodes={productionWorkflowDisplay?.displayOrderCodes}
                codeToLetter={productionWorkflowDisplay?.codeToLetter}
                codeToName={productionWorkflowDisplay?.codeToName}
                fontSize={9}
                showTooltip={false}
                passedColor="#d46b08"
              />
            </span>
          ) : <span />}
          {payment ? (
            <span className={payment.toLowerCase().includes('не оплачен') ? 'wb-cal-print__payment wb-cal-print__payment--danger' : 'wb-cal-print__payment'}>
              {payment}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

interface SheetsProps {
  sheets: CalendarPrintSheet[];
  paper: CalendarPrintPaper;
  title: string;
  filterLine: string;
  stamp: string;
  showFinancials: boolean;
  productionWorkflowDisplay?: ProductionWorkflowDisplay;
}

export const CalendarPrintSheets: React.FC<SheetsProps> = ({
  sheets, paper, title, filterLine, stamp, showFinancials, productionWorkflowDisplay,
}) => {
  const size = CALENDAR_PRINT_PAPERS[paper];
  return (
    <>
      {sheets.map((sheet, sheetIndex) => (
        <section
          key={sheet.weeks[0]?.label ?? sheetIndex}
          className="wb-cal-print__sheet"
          style={{ ['--wb-print-width' as string]: `${size.widthMm - CALENDAR_PRINT_MARGIN_MM * 2}mm` }}
        >
          <header className="wb-cal-print__header">
            <b>Производственный календарь</b>
            <span>{title}</span>
            <span className="wb-cal-print__filters">{filterLine}</span>
            <span className="wb-cal-print__stamp">на {stamp} · лист {sheetIndex + 1} из {sheets.length}</span>
          </header>
          {sheet.weeks.map((week) => (
            <table key={week.label} className="wb-cal-print__week">
              <caption>{week.label}</caption>
              <thead>
                <tr>
                  {week.days.map((day) => (
                    <th key={day.key} data-weekend={day.weekend || undefined} data-today={day.today || undefined}>
                      <span className="wb-cal-print__day">{day.weekday} <b>{day.dayMonth}</b></span>
                      <span className="wb-cal-print__load">
                        {day.orders.length > 0
                          ? `${day.orders.length} ${ordersWord(day.orders.length)} · ${day.area.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м²`
                          : '—'}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  {week.days.map((day) => (
                    <td key={day.key} data-weekend={day.weekend || undefined}>
                      {day.orders.map((order) => (
                        <PrintCard
                          key={order.order_id}
                          order={order}
                          showFinancials={showFinancials}
                          productionWorkflowDisplay={productionWorkflowDisplay}
                        />
                      ))}
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          ))}
        </section>
      ))}
    </>
  );
};

export interface CalendarPrintButtonProps {
  weeks: readonly WorkbenchWeek[];
  ordersOf: (day: Date) => CalendarOrder[];
  periodLabel: string;
  filters: CalendarFilters;
  productionOnly: boolean;
  showFinancials: boolean;
  productionWorkflowDisplay?: ProductionWorkflowDisplay;
  disabled?: boolean;
}

export const CalendarPrintButton: React.FC<CalendarPrintButtonProps> = ({
  weeks, ordersOf, periodLabel, filters, productionOnly, showFinancials, productionWorkflowDisplay, disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [paper, setPaper] = useState<CalendarPrintPaper>(readPaper);
  const [printing, setPrinting] = useState(false);
  const [now, setNow] = useState(() => new Date());

  const sheets = useMemo(
    () => (open ? buildCalendarPrintSheets(weeks, ordersOf, paper, now) : []),
    [now, open, ordersOf, paper, weeks],
  );
  const stats = useMemo(() => calendarPrintStats(sheets), [sheets]);
  const filterLine = calendarPrintFilterLine(filters, productionOnly, showFinancials);
  const stamp = calendarPrintStamp(now);
  const firstDay = weeks[0]?.days[0];
  const lastDay = weeks.at(-1)?.days.at(-1);
  const title = firstDay && lastDay ? `${formatDateKey(firstDay)} – ${formatDateKey(lastDay)}` : periodLabel;

  useEffect(() => {
    if (!printing) return undefined;
    const root = document.documentElement;
    root.classList.add(PRINTING_CLASS);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.classList.remove(PRINTING_CLASS);
      setPrinting(false);
    };
    window.addEventListener('afterprint', finish);
    // two frames: the portal is laid out before the print snapshot
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      window.print();
      finish();
    }));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', finish);
      root.classList.remove(PRINTING_CLASS);
    };
  }, [printing]);

  const choosePaper = (value: CalendarPrintPaper) => {
    setPaper(value);
    try {
      window.localStorage.setItem(PAPER_STORAGE_KEY, value);
    } catch {
      // only a convenience
    }
  };

  const size = CALENDAR_PRINT_PAPERS[paper];
  const sheetsProps = { sheets, paper, title, filterLine, stamp, showFinancials, productionWorkflowDisplay };

  return (
    <>
      <Button
        icon={<PrinterOutlined />}
        disabled={disabled}
        onClick={() => { setNow(new Date()); setOpen(true); }}
      >
        Печать
      </Button>
      <Modal
        open={open}
        title="Печать календаря"
        width={1000}
        className="wb-cal-print-dialog"
        onCancel={() => setOpen(false)}
        destroyOnClose
        footer={(
          <Space>
            <Button onClick={() => setOpen(false)}>Отмена</Button>
            <Button type="primary" icon={<PrinterOutlined />} disabled={sheets.length === 0} onClick={() => setPrinting(true)}>
              Печать
            </Button>
          </Space>
        )}
      >
        <div className="wb-cal-print-dialog__options">
          <span>Формат листа</span>
          <Segmented
            value={paper}
            options={[
              { label: 'A4 альбом', value: 'A4' },
              { label: 'A3 альбом', value: 'A3' },
            ]}
            onChange={(value) => choosePaper(value as CalendarPrintPaper)}
          />
          <span className="wb-cal-print-dialog__summary">
            {title} · {stats.orders} {ordersWord(stats.orders)} · {stats.area.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м²
            {' · '}листов: {sheets.length}
          </span>
        </div>
        <p className="wb-cal-print-dialog__hint">
          Печатается период и заказы, как на экране ({filterLine}). Неделя, две или месяц выбираются над календарём.
          В окне печати браузера можно выбрать «Сохранить как PDF».
        </p>
        <div className="wb-cal-print wb-cal-print--preview">
          <CalendarPrintSheets {...sheetsProps} />
        </div>
      </Modal>
      {printing ? createPortal(
        <div className="wb-cal-print wb-cal-print--paper">
          <style>{`@page { size: ${size.label} landscape; margin: ${CALENDAR_PRINT_MARGIN_MM}mm; }`}</style>
          <CalendarPrintSheets {...sheetsProps} />
        </div>,
        document.body,
      ) : null}
    </>
  );
};
