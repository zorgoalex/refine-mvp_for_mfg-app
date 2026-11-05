// «NewLine»: the printed production calendar is the calendar itself — copies of its week rows (the cards exactly as
// on screen in the chosen view: icons, letters, chips, outlines), a week per A4 sheet or two per A3, scaled to the
// sheet width.
import type { CalendarPrintPaper } from './calendarPrintModel';
import { CALENDAR_PRINT_PAPERS, CALENDAR_PRINT_MARGIN_MM } from './calendarPrintModel';

export const calendarPrintSheetWidthPx = (paper: CalendarPrintPaper): number =>
  Math.floor(((CALENDAR_PRINT_PAPERS[paper].widthMm - CALENDAR_PRINT_MARGIN_MM * 2) * 96) / 25.4);

export interface CalendarPrintSheetOptions {
  grid: HTMLElement;
  paper: CalendarPrintPaper;
  title: string;
  period: string;
  filterLine: string;
  stamp: string;
}

/** Week units of the grid: a week label (when the grid shows whole weeks) with its row of days. */
function weekUnits(grid: HTMLElement): HTMLElement[][] {
  const units: HTMLElement[][] = [];
  let label: HTMLElement | null = null;
  Array.from(grid.children).forEach((child) => {
    const element = child as HTMLElement;
    if (element.classList.contains('wb-cal-week-label')) {
      label = element;
      return;
    }
    if (element.classList.contains('calendar-row')) {
      units.push(label ? [label, element] : [element]);
      label = null;
    }
  });
  return units;
}

function cleanCopy(element: HTMLElement): HTMLElement {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll<HTMLElement>('[id]').forEach((node) => node.removeAttribute('id'));
  copy.querySelectorAll<HTMLElement>('[tabindex]').forEach((node) => node.removeAttribute('tabindex'));
  return copy;
}

/** Detached sheets: the calendar's own classes around copies of its weeks, with the sheet header. */
export function buildCalendarPrintSheets(options: CalendarPrintSheetOptions): HTMLElement[] {
  const { grid, paper, title, period, filterLine, stamp } = options;
  const perSheet = CALENDAR_PRINT_PAPERS[paper].weeksPerSheet;
  const units = weekUnits(grid);
  const sheets: HTMLElement[] = [];
  const total = Math.ceil(units.length / perSheet);
  for (let index = 0; index < units.length; index += perSheet) {
    const sheet = document.createElement('section');
    sheet.className = 'calendar-board calendar-board--wb calendar-board--wb-weeks wb-cal-print-sheet';
    sheet.style.width = `${calendarPrintSheetWidthPx(paper)}px`;
    const header = document.createElement('header');
    header.className = 'wb-cal-print-sheet__header';
    const heading = document.createElement('b');
    heading.textContent = title;
    const periodNode = document.createElement('span');
    periodNode.textContent = period;
    const filters = document.createElement('span');
    filters.className = 'wb-cal-print-sheet__filters';
    filters.textContent = filterLine;
    const stampNode = document.createElement('span');
    stampNode.className = 'wb-cal-print-sheet__stamp';
    stampNode.textContent = `на ${stamp} · лист ${sheets.length + 1} из ${total}`;
    header.append(heading, periodNode, filters, stampNode);
    const copyGrid = document.createElement('div');
    copyGrid.className = 'calendar-grid';
    units.slice(index, index + perSheet).forEach((unit) => unit.forEach((part) => copyGrid.append(cleanCopy(part))));
    sheet.append(header, copyGrid);
    sheets.push(sheet);
  }
  return sheets;
}

/** Scale the attached sheet's weeks to the room inside the sheet, by their real laid-out width. */
export function fitCalendarPrintSheet(sheet: HTMLElement): void {
  const grid = sheet.querySelector<HTMLElement>(':scope > .calendar-grid');
  if (!grid) return;
  const style = getComputedStyle(sheet);
  const available = sheet.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
  if (!(available > 0)) return;
  grid.style.setProperty('zoom', '1');
  grid.style.width = 'max-content';
  const natural = grid.scrollWidth;
  if (natural > 0) grid.style.setProperty('zoom', String(Math.min(1, Math.floor((available / natural) * 1000) / 1000)));
}
