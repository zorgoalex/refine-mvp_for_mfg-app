import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chosenMdfPrintColumns, mdfPrint } from './mdfPrintStore';

const columns = [{ key: 'parsed' }, { key: 'completed' }, { key: 'baths' }, { key: 'orders' }];

describe('MDF board print', () => {
  it('prints every column by default, the chosen ones in board order', () => {
    expect(chosenMdfPrintColumns(columns, null).map((c) => c.key)).toEqual(['parsed', 'completed', 'baths', 'orders']);
    expect(chosenMdfPrintColumns(columns, ['orders', 'baths', 'gone']).map((c) => c.key)).toEqual(['baths', 'orders']);
    expect(chosenMdfPrintColumns(columns, [])).toEqual([]);
  });

  it('opening resets the choice and the printing flag', () => {
    mdfPrint.open();
    mdfPrint.setColumnKeys(['baths']);
    mdfPrint.setPrinting(true);
    mdfPrint.open();
    expect(mdfPrint.get()).toMatchObject({ open: true, printing: false, columnKeys: null });
    mdfPrint.close();
    expect(mdfPrint.get()).toMatchObject({ open: false, printing: false });
  });

  it('while printing from NewLine only the board sheet is printed; colours and preview come from mdfPrint.css', () => {
    const css = readFileSync(join(__dirname, 'mdfPrint.css'), 'utf8');
    expect(css).toContain('html.wb-mdf-printing body > :not(.cnc-print-board)');
    expect(css).toContain('.cnc-print-board[data-colored] thead th');
    expect(css).toContain('.wb-mdf-print-preview .cnc-print-board');
    const page = readFileSync(join(__dirname, '..', 'OrderStatusBoardPage.tsx'), 'utf8');
    expect(page).toContain("cardDisplayMode === 'standard' && mdfPrintState.printing && createPortal(");
    expect(page).toContain('onClick={() => mdfPrint.open()}');
  });
});
