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

  it('can append one blank label as the last print page', () => {
    const html = buildLabelPrintDocument([
      '<svg width="85mm" height="55mm"><text>1</text></svg>',
      '<svg width="85mm" height="55mm"><text>2</text></svg>',
    ], 'Бирки', { appendBlankPage: true });

    expect(html.match(/<section class="label-print-page/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Пустая бирка"');
    expect(html).toContain('label-print-page__inner--blank');
    expect(html.indexOf('aria-label="Пустая бирка"')).toBeGreaterThan(html.indexOf('aria-label="Бирка 2"'));
  });

  it('does not open print for an empty page list', () => {
    expect(printLabelSvgPages([])).toBe(false);
  });
});
