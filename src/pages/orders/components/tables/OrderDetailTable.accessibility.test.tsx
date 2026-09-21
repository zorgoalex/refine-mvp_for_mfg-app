import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Table } from '../../../../ui/tooltipDelay';

// Evaluate the production memo wrapper without mounting the unrelated editor.
const source = readFileSync(new URL('./OrderDetailTable.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('table.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === 'MemoizedOrderDetailTable') expression = node.initializer;
  ts.forEachChild(node, visit);
}
visit(ast);
if (!expression) throw new Error('Missing production table memo');
const body = ts.transpileModule(`return ${expression.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const MemoTable = new Function('React', 'Table', body)(React, Table);

describe('detail table accessibility contract', () => {
  it('renders the existing grid role and accessible name through the real Table', () => {
    const html = renderToStaticMarkup(<MemoTable renderVersion="test" role="grid"
      aria-label="Тест детали" pagination={false}
      columns={[{ dataIndex: 'name', title: 'Имя' }]}
      dataSource={[{ key: 'test', name: 'Тест деталь' }]} />);
    expect(html).toContain('role="grid"');
    expect(html).toContain('aria-label="Тест детали"');
    expect(html).toContain('Тест деталь');
    expect(html).not.toContain('renderVersion');
  });

  it('forwards row/cell keyboard handlers and components without wrapping them', () => {
    const onRow = () => ({ onKeyDown: () => undefined });
    const components = { body: { cell: 'td' } };
    const rendered = MemoTable.type({ renderVersion: 'test', onRow, components });
    expect(rendered.props.onRow).toBe(onRow);
    expect(rendered.props.components).toBe(components);
    expect(rendered.props).not.toHaveProperty('renderVersion');
  });
});
