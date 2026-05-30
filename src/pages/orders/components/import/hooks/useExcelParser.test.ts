// TDD test: verifies that the dynamic-import parseWorksheet logic produces the
// correct ParsedSheet shape. We test the pure parse helper directly to avoid
// needing React test utilities. The dynamic import path is exercised by calling
// the helper with a live XLSX module.
import { describe, it, expect } from 'vitest';
import type { ParsedSheet } from '../types/importTypes';
import { getColumnLetter } from '../types/importTypes';

// Import the pure parse helper exported from the hook.
// parseWorksheet accepts (ws, utils) so it can be tested without a top-level
// XLSX import — the test obtains the module via its own dynamic import below.
import { parseWorksheet } from './useExcelParser';

describe('parseWorksheet (dynamic xlsx)', () => {
  it('parses a small in-memory workbook correctly', async () => {
    // Dynamically import xlsx (mirrors what the refactored hook does at runtime)
    const XLSX = await import('xlsx');

    const aoa = [
      ['Name', 'Width', 'Height'],
      ['Door', 800, 2000],
      ['Window', 600, 1200],
    ];

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const result: ParsedSheet = parseWorksheet(ws, XLSX.utils);

    // Headers should be Excel column letters A, B, C (3 columns)
    expect(result.headers).toEqual(['A', 'B', 'C']);
    expect(result.rowCount).toBe(3);
    expect(result.colCount).toBe(3);

    // Data integrity: first row
    expect(result.data[0][0]).toBe('Name');
    expect(result.data[0][1]).toBe('Width');
    expect(result.data[0][2]).toBe('Height');

    // Second row: numbers
    expect(result.data[1][0]).toBe('Door');
    expect(result.data[1][1]).toBe(800);
    expect(result.data[1][2]).toBe(2000);

    // Third row
    expect(result.data[2][0]).toBe('Window');
    expect(result.data[2][1]).toBe(600);
    expect(result.data[2][2]).toBe(1200);

    // name defaults to empty string (caller sets it after)
    expect(result.name).toBe('');
  });

  it('returns correct column letters via getColumnLetter', () => {
    expect(getColumnLetter(0)).toBe('A');
    expect(getColumnLetter(1)).toBe('B');
    expect(getColumnLetter(25)).toBe('Z');
    expect(getColumnLetter(26)).toBe('AA');
  });

  it('handles a single-cell sheet', async () => {
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([['hello']]);
    const result = parseWorksheet(ws, XLSX.utils);

    expect(result.rowCount).toBe(1);
    expect(result.colCount).toBe(1);
    expect(result.data[0][0]).toBe('hello');
    expect(result.headers).toEqual(['A']);
  });
});
