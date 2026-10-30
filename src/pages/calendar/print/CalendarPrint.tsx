// «NewLine»: «Печать» of the production calendar — a dialog with the sheet preview, then the browser print
// (where «Сохранить как PDF» is too). The sheets are copies of the calendar itself (its week rows with the cards as
// on screen in the chosen view), mounted into <body> only while printing.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Space } from 'antd';
import { PrinterOutlined } from '@ant-design/icons';
import { Segmented } from '../../../ui/Segmented';
import type { CalendarFilters, CalendarOrder } from '../types/calendar';
import { formatDateKey } from '../utils/dateUtils';
import type { WorkbenchWeek } from '../utils/workbenchCalendar';
import {
  buildCalendarPrintSheets as buildCalendarPrintModel,
  CALENDAR_PRINT_MARGIN_MM,
  calendarPrintFilterLine,
  calendarPrintStamp,
  calendarPrintStats,
  ordersWord,
  type CalendarPrintPaper,
} from './calendarPrintModel';
import { buildCalendarPrintSheets, fitCalendarPrintSheet } from './calendarPrintSheet';
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

export interface CalendarPrintButtonProps {
  weeks: readonly WorkbenchWeek[];
  ordersOf: (day: Date) => CalendarOrder[];
  periodLabel: string;
  filters: CalendarFilters;
  productionOnly: boolean;
  showFinancials: boolean;
  /** «Подробно», «Компактно», «Кратко» — the card view on screen, printed as it is */
  viewLabel: string;
  /** the calendar's own week grid; the sheets are copies of it */
  getGrid: () => HTMLElement | null;
  disabled?: boolean;
}

export const CalendarPrintButton: React.FC<CalendarPrintButtonProps> = ({
  weeks, ordersOf, periodLabel, filters, productionOnly, showFinancials, viewLabel, getGrid, disabled,
}) => {
  const [open, setOpen] = useState(false);
  const [paper, setPaper] = useState<CalendarPrintPaper>(readPaper);
  const [printing, setPrinting] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const previewRef = useRef<HTMLDivElement | null>(null);

  const model = useMemo(
    () => (open ? buildCalendarPrintModel(weeks, ordersOf, paper, now) : []),
    [now, open, ordersOf, paper, weeks],
  );
  const stats = useMemo(() => calendarPrintStats(model), [model]);
  const filterLine = calendarPrintFilterLine(filters, productionOnly, showFinancials);
  const stamp = calendarPrintStamp(now);
  const firstDay = weeks[0]?.days[0];
  const lastDay = weeks.at(-1)?.days.at(-1);
  const period = firstDay && lastDay ? `${formatDateKey(firstDay)} – ${formatDateKey(lastDay)}` : periodLabel;

  const buildSheets = (): HTMLElement[] => {
    const grid = getGrid();
    if (!grid) return [];
    return buildCalendarPrintSheets({
      grid,
      paper,
      title: 'Производственный календарь',
      period: viewLabel ? `${period} · вид «${viewLabel}»` : period,
      filterLine,
      stamp,
    });
  };

  // preview: copies of the calendar weeks, after the dialog has opened
  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      const holder = previewRef.current;
      if (!holder) return;
      holder.replaceChildren();
      for (const sheet of buildSheets()) {
        holder.append(sheet);
        fitCalendarPrintSheet(sheet);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, paper, now, viewLabel, filterLine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!printing) return undefined;
    const root = document.documentElement;
    const container = document.createElement('div');
    container.className = 'wb-cal-print-live';
    const style = document.createElement('style');
    style.textContent = `@page { size: ${paper} landscape; margin: ${CALENDAR_PRINT_MARGIN_MM}mm; }`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      root.classList.remove(PRINTING_CLASS);
      container.remove();
      style.remove();
      setPrinting(false);
    };
    const sheets = buildSheets();
    // laid out off screen once, so each sheet can be scaled by its real width (on screen the container is hidden)
    container.style.cssText = 'display:block;position:absolute;left:-100000px;top:0;visibility:hidden';
    sheets.forEach((sheet) => container.append(sheet));
    document.body.append(container);
    sheets.forEach(fitCalendarPrintSheet);
    container.style.cssText = '';
    document.head.append(style);
    root.classList.add(PRINTING_CLASS);
    window.addEventListener('afterprint', finish, { once: true });
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => {
      window.print();
      finish();
    }));
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('afterprint', finish);
      root.classList.remove(PRINTING_CLASS);
      container.remove();
      style.remove();
    };
  }, [printing]); // eslint-disable-line react-hooks/exhaustive-deps

  const choosePaper = (value: CalendarPrintPaper) => {
    setPaper(value);
    try {
      window.localStorage.setItem(PAPER_STORAGE_KEY, value);
    } catch {
      // only a convenience
    }
  };

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
            <Button type="primary" icon={<PrinterOutlined />} disabled={model.length === 0} loading={printing} onClick={() => setPrinting(true)}>
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
            {period} · {stats.orders} {ordersWord(stats.orders)} · {stats.area.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} м²
            {' · '}листов: {model.length}
          </span>
        </div>
        <p className="wb-cal-print-dialog__hint">
          Печатается календарь как на экране{viewLabel ? <> — вид «{viewLabel}»</> : null}: те же карточки, период и
          заказы ({filterLine}). Неделя, две или месяц и вид карточек выбираются над календарём. В окне печати браузера
          можно выбрать «Сохранить как PDF».
        </p>
        <div className="wb-cal-print-preview" data-paper={paper}>
          <div ref={previewRef} />
        </div>
      </Modal>
    </>
  );
};
