import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chosenMdfPrintColumns, mdfPrint } from './mdfPrintStore';
import { MDF_PRINT_SHEET_WIDTH_PX, mdfPrintZoom } from './mdfPrintSheet';

const columns = [{ key: 'parsed' }, { key: 'completed' }, { key: 'baths' }, { key: 'orders' }];

describe('MDF board print', () => {
  it('prints every column by default, the chosen ones in board order', () => {
    expect(chosenMdfPrintColumns(columns, null).map((c) => c.key)).toEqual(['parsed', 'completed', 'baths', 'orders']);
    expect(chosenMdfPrintColumns(columns, ['orders', 'baths', 'gone']).map((c) => c.key)).toEqual(['baths', 'orders']);
    expect(chosenMdfPrintColumns(columns, [])).toEqual([]);
  });

  it('opening resets the choice; closing makes the board cards lazy again (a new generation)', () => {
    mdfPrint.open();
    mdfPrint.setColumnKeys(['baths']);
    mdfPrint.setPrinting(true);
    const generation = mdfPrint.get().generation;
    mdfPrint.open();
    expect(mdfPrint.get()).toMatchObject({ open: true, printing: false, columnKeys: null });
    mdfPrint.close();
    expect(mdfPrint.get()).toMatchObject({ open: false, printing: false, generation: generation + 1 });
  });

  it('the chosen columns are shrunk to the sheet width, never enlarged', () => {
    expect(MDF_PRINT_SHEET_WIDTH_PX.A4).toBe(1062);
    expect(MDF_PRINT_SHEET_WIDTH_PX.A3).toBe(1526);
    expect(mdfPrintZoom(2400, 8, 8, 1062)).toBe(0.443);
    expect(mdfPrintZoom(2400, 8, 2, 1062)).toBe(1);
    expect(mdfPrintZoom(0, 8, 8, 1062)).toBe(1);
  });

  it('the board itself is printed: all cards drawn while the dialog is open, the copy isolated on paper', () => {
    const page = readFileSync(join(__dirname, '..', 'OrderStatusBoardPage.tsx'), 'utf8');
    expect(page).toContain('const mdfPrintAll = isWorkbenchUi && mdfPrintState.open;');
    expect(page.match(/defer=\{!mdfPrintAll && shouldDeferCncCard\(/g)?.length).toBe(4);
    expect(page).toContain('&& !mdfPrintAll');
    expect(page).toContain('getBoard={() => mdfPrintSourceRef.current}');
    const css = readFileSync(join(__dirname, 'mdfPrint.css'), 'utf8');
    expect(css).toContain('html.wb-mdf-printing body > :not(.wb-mdf-print-live)');
    expect(css).toContain('.wb-mdf-print-sheet .status-board-column__header');
  });
});
