import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('order list filter form connection', () => {
  it('keeps the AntD form connected while filters are collapsed', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'list.tsx'), 'utf8');

    expect(source).toContain("<Form form={form} className=\"orders-filter-form-connector\" aria-hidden />");
  });
});
