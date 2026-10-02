import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The order forms are built by the same code in the browser and on the backend. The backend keeps
// exact copies (its build cannot reach the frontend sources): after changing a source, copy it again.
const repoRoot = resolve(__dirname, '../../../../../../..');
const copies: Array<[string, string]> = [
  ['src/utils/excel/orderExcelBuilder.ts', 'backend/src/modules/whatsapp/order-send/forms/shared/excel/orderExcelBuilder.ts'],
  ['src/utils/excel/excelErrorHandler.ts', 'backend/src/modules/whatsapp/order-send/forms/shared/excel/excelErrorHandler.ts'],
  ['src/utils/printFormat.ts', 'backend/src/modules/whatsapp/order-send/forms/shared/printFormat.ts'],
  ['public/templates/order_template.xlsx', 'backend/assets/order-forms/order_template.xlsx'],
];

describe('order form sources shared with the frontend', () => {
  it.each(copies)('%s is copied byte for byte', (source, copy) => {
    expect(readFileSync(resolve(repoRoot, copy)).equals(readFileSync(resolve(repoRoot, source)))).toBe(true);
  });
});
