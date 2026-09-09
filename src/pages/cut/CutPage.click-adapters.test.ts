import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual JSX handlers without mounting CutPage's API/editor tree.
// Full-page browser tests cover the resulting HTTP filters in both UI variants.
const source = ts.createSourceFile('CutPage.tsx', readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const refreshButtons: ts.JsxAttributes[] = [];
function visit(node: ts.Node) {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && node.tagName.getText(source) === 'Button'
    && node.attributes.properties.some((prop) => ts.isJsxAttribute(prop)
      && prop.name.getText(source) === 'loading'
      && prop.initializer?.getText(source) === '{jobsLoading}')) {
    refreshButtons.push(node.attributes);
  }
  ts.forEachChild(node, visit);
}
visit(source);

describe('CutPage refresh click adapters', () => {
  it('covers both legacy and operational refresh buttons', () => {
    expect(refreshButtons).toHaveLength(2);
  });

  for (const [index, attributes] of refreshButtons.entries()) {
    it(`button ${index + 1} calls loadJobs once without forwarding the mouse event`, () => {
      const attribute = attributes.properties.find((prop) => ts.isJsxAttribute(prop) && prop.name.getText(source) === 'onClick');
      if (!attribute || !ts.isJsxAttribute(attribute) || !attribute.initializer
        || !ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) {
        throw new Error('Refresh button must have an executable onClick');
      }
      const loadJobs = vi.fn().mockResolvedValue(undefined);
      const handler = runInNewContext(`(${attribute.initializer.expression.getText(source)})`, { loadJobs });
      handler({ type: 'click', target: { tagName: 'BUTTON' }, preventDefault: vi.fn() });
      expect(loadJobs).toHaveBeenCalledExactlyOnceWith();
    });
  }
});
