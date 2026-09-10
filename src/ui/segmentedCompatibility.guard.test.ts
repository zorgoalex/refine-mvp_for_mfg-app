import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const pages = [
  ['src/pages/audit/list.tsx', 1],
  ['src/pages/configuration/components/CutConfigTab.tsx', 4],
  ['src/pages/configuration/components/CutDefaultSettingsCard.tsx', 3],
  ['src/pages/configuration/components/CutRenderStylesForm.tsx', 2],
  ['src/pages/configuration/components/FinancialLayerAccessMatrix.tsx', 1],
  ['src/pages/order_resource_requirements/list.tsx', 2],
  ['src/pages/orders/list.tsx', 1],
  ['src/pages/orderStatusBoard/OrderStatusBoardPage.tsx', 7],
  ['src/pages/calendar/components/CalendarBoard.tsx', 4],
] as const;

describe('Segmented page wiring', () => {
  it.each(pages)('%s uses the shared adapter at all %i callsites', (file, expectedCount) => {
    const source = readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = ast.statements.filter(ts.isImportDeclaration);
    const importedFrom = imports.filter(node => node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.some(element => (element.propertyName ?? element.name).text === 'Segmented'))
      .map(node => (node.moduleSpecifier as ts.StringLiteral).text);
    expect(importedFrom).toHaveLength(1);
    expect(path.resolve(path.dirname(file), importedFrom[0])).toBe(path.resolve('src/ui/Segmented'));
    let count = 0;
    function visit(node: ts.Node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === 'Segmented') count++;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(count).toBe(expectedCount);
    expect(source).not.toContain('CalendarSegmented');
    expect(source).not.toMatch(/onResizeCapture|onPointerEnterCapture|onPointerLeaveCapture/);
  });
});
