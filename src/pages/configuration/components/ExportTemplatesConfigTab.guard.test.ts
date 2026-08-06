import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('export templates editor layout', () => {
  it('keeps numbered template rows compact and wraps long formulas without horizontal scrolling', () => {
    const component = fs.readFileSync(path.resolve(__dirname, 'ExportTemplatesConfigTab.tsx'), 'utf8');
    const styles = fs.readFileSync(path.resolve(__dirname, 'ExportTemplatesConfigTab.css'), 'utf8');

    expect(component).toContain('className="export-templates-list-pane"');
    expect(component).toContain('className="export-templates-editor-pane"');
    expect(styles).toContain('flex: 0 0 14.583333%');
    expect(styles).toContain('flex: 0 0 85.416667%');
    expect(component).toContain('className="export-template-columns"');
    expect(component).toContain('className="export-template-column-row"');
    expect(component).toContain('className="export-template-column-index"');
    expect(component).toContain('columns={draft.columns} currentColumnKey={column.columnKey}');
    expect(component).toContain('removeColumn(index, draft, setDraft)');
    expect(styles).toContain('--export-template-row-control-height: 28px');
    expect(styles).toContain('row-gap: 2px');
    expect(styles).toMatch(/\.export-template-column-row\s*\{[\s\S]*flex-wrap: wrap/);
    expect(styles).toMatch(/\.export-template-column-expression\s*\{[\s\S]*min-width: 0/);
    expect(styles).toMatch(/\.export-expression-editor-row[\s\S]*flex-wrap: wrap/);
    expect(styles).not.toContain('overflow-x: auto');
    expect(styles).not.toContain('width: max-content');
    expect(styles).not.toContain('flex-wrap: nowrap');
  });
});
