// «NewLine»: the printed MDF board is the board itself — a copy of its columns (the cards exactly as on screen in
// the chosen card mode), only the chosen columns, scaled to the width of the sheet.
import type { MdfPrintPaper } from './mdfPrintStore';

/** Printable width of a landscape sheet at 8 mm margins, in CSS pixels (96 per inch). */
export const MDF_PRINT_SHEET_WIDTH_PX: Record<MdfPrintPaper, number> = {
  A4: Math.floor(((297 - 16) * 96) / 25.4),
  A3: Math.floor(((420 - 16) * 96) / 25.4),
};

/** Scale of the copy so that the chosen columns fit the sheet width (never enlarged). */
export function mdfPrintZoom(boardWidth: number, totalColumns: number, chosenColumns: number, sheetWidth: number): number {
  if (boardWidth <= 0 || totalColumns <= 0 || chosenColumns <= 0) return 1;
  const naturalWidth = (boardWidth / totalColumns) * chosenColumns;
  return Math.min(1, Math.round((sheetWidth / naturalWidth) * 1000) / 1000);
}

export interface MdfPrintSheetOptions {
  board: HTMLElement;
  columnKeys: readonly string[];
  paper: MdfPrintPaper;
  title: string;
  printDate: string;
  modeLabel: string;
  /** width the sheet is laid out at (the preview may be narrower than the paper) */
  sheetWidth?: number;
}

/** A detached copy of the board for the sheet: chosen columns in board order, laid out side by side. */
export function buildMdfPrintSheet(options: MdfPrintSheetOptions): HTMLElement {
  const { board, columnKeys, paper, title, printDate, modeLabel } = options;
  const sheetWidth = options.sheetWidth ?? MDF_PRINT_SHEET_WIDTH_PX[paper];
  const chosen = new Set(columnKeys);
  const liveColumns = Array.from(board.querySelectorAll<HTMLElement>(':scope > [data-status-board-column-key]'));

  // the board's own page classes, so its styles (and the NewLine ones) apply to the copy
  const sheet = document.createElement('div');
  sheet.className = 'status-board-page status-board-page--cnc wb-mdf-print-sheet';
  sheet.style.width = `${sheetWidth}px`;

  const header = document.createElement('header');
  header.className = 'wb-mdf-print-sheet__header';
  const heading = document.createElement('b');
  heading.textContent = title;
  const meta = document.createElement('span');
  meta.textContent = [printDate, modeLabel ? `вид «${modeLabel}»` : ''].filter(Boolean).join(' · ');
  header.append(heading, meta);
  sheet.append(header);

  const copy = board.cloneNode(true) as HTMLElement;
  copy.removeAttribute('style');
  // a copy for paper: no ids, focus stops or deep-link highlight of the live board
  copy.querySelectorAll<HTMLElement>('[id]').forEach((element) => element.removeAttribute('id'));
  copy.querySelectorAll<HTMLElement>('[tabindex]').forEach((element) => element.removeAttribute('tabindex'));
  copy.querySelectorAll<HTMLElement>('.cnc-board-card-shell--deep-linked').forEach((element) => {
    element.classList.remove('cnc-board-card-shell--deep-linked');
  });
  // the detailed bath view covers columns on screen; the copy prints the columns themselves
  copy.classList.remove('status-board-columns--cnc-detailed');
  copy.querySelectorAll<HTMLElement>('.cnc-today-column--detailed-covered, .cnc-today-column--detailed').forEach((element) => {
    element.classList.remove('cnc-today-column--detailed-covered', 'cnc-today-column--detailed');
  });
  const copiedColumns = Array.from(copy.querySelectorAll<HTMLElement>(':scope > [data-status-board-column-key]'));
  let index = 0;
  copiedColumns.forEach((column) => {
    if (!chosen.has(column.dataset.statusBoardColumnKey ?? '')) {
      column.remove();
      return;
    }
    index += 1;
    column.style.gridColumn = String(index);
    column.style.gridRow = '1';
    column.removeAttribute('aria-hidden');
  });
  // anything else the board draws over its columns (detailed bath panel, drag layers) is not printed
  Array.from(copy.children).forEach((child) => {
    if (!(child as HTMLElement).dataset.statusBoardColumnKey) child.remove();
  });
  // columns as wide as on the board (their own minimum widths); the copy is scaled to the sheet once laid out
  const zoom = mdfPrintZoom(board.scrollWidth, liveColumns.length, index, sheetWidth);
  const columnWidth = liveColumns.length > 0 ? Math.round(board.scrollWidth / liveColumns.length) : 0;
  copy.style.gridTemplateColumns = columnWidth > 0
    ? `repeat(${Math.max(1, index)}, ${columnWidth}px)`
    : `repeat(${Math.max(1, index)}, minmax(0, 1fr))`;
  copy.style.width = 'max-content';
  copy.style.setProperty('zoom', String(zoom));
  sheet.dataset.sheetWidth = String(sheetWidth);
  sheet.append(copy);
  return sheet;
}

/**
 * Scale the attached copy to the sheet by its real laid-out width (columns keep their own minimum widths, so the
 * estimate from the board may be off). The sheet must be laid out (attached and displayed) when called.
 */
export function fitMdfPrintSheet(sheet: HTMLElement): void {
  const copy = sheet.querySelector<HTMLElement>(':scope > .status-board-columns');
  if (!copy) return;
  // the room inside the sheet (a preview sheet has its paper margins as padding)
  const style = getComputedStyle(sheet);
  const available = sheet.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
  if (!(available > 0)) return;
  copy.style.setProperty('zoom', '1');
  const natural = copy.scrollWidth;
  if (natural > 0) copy.style.setProperty('zoom', String(Math.min(1, Math.floor((available / natural) * 1000) / 1000)));
}
