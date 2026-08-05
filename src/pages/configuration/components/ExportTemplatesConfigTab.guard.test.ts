import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('export templates editor layout', () => {
  it('keeps the template list narrow and each export column on one row', () => {
    const component = fs.readFileSync(path.resolve(__dirname, 'ExportTemplatesConfigTab.tsx'), 'utf8');
    const styles = fs.readFileSync(path.resolve(__dirname, 'ExportTemplatesConfigTab.css'), 'utf8');

    expect(component).toContain('className="export-templates-list-pane"');
    expect(component).toContain('className="export-templates-editor-pane"');
    expect(styles).toContain('flex: 0 0 14.583333%');
    expect(styles).toContain('flex: 0 0 85.416667%');
    expect(component).toContain('className="export-template-column-row"');
    expect(styles).toContain('grid-template-columns: 28px 220px minmax(420px, 1fr) auto');
    expect(styles).toContain('flex-wrap: nowrap');
    expect(styles).toContain('overflow-x: auto');
  });
});
