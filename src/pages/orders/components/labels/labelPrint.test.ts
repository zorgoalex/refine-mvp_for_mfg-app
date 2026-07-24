import { describe, expect, it } from 'vitest';
import { buildLabelPrintDocument, printLabelSvgPages } from './labelPrint';

describe('label print document', () => {
  it('renders every label as a separate print page', () => {
    const html = buildLabelPrintDocument([
      '<svg width="85mm" height="55mm"><text>1</text></svg>',
      '<svg width="85mm" height="55mm"><text>2</text></svg>',
    ], 'Заказ <42>');

    expect(html).toContain('<title>Заказ &lt;42&gt;</title>');
    expect(html.match(/class="label-print-page"/g)).toHaveLength(2);
    expect(html).toContain('page-break-after: always');
    expect(html).toContain('break-after: page');
    expect(html).toContain('max-height: 100vh');
  });

  it('does not open print for an empty page list', () => {
    expect(printLabelSvgPages([])).toBe(false);
  });
});
