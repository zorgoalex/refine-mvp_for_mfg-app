import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Collapse } from 'antd';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const targets = [
  ['src/pages/cut/CutPage.tsx', 'cut-results-history-collapse'],
  ['src/pages/cut/CutPage.tsx', 'cut-page-modern__details'],
  ['src/pages/orderStatusBoard/OrderStatusBoardPage.tsx', 'cnc-packet-card__sheet'],
] as const;

describe('installed Collapse compatibility', () => {
  it.each(targets)('%s: %s uses supported props', (file, className) => {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const matches: ts.JsxOpeningElement[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === 'Collapse'
        && node.attributes.properties.some(prop => ts.isJsxAttribute(prop)
          && prop.name.getText(source) === 'className'
          && prop.initializer && ts.isStringLiteral(prop.initializer)
          && prop.initializer.text === className)) matches.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(matches).toHaveLength(1);
    const props = matches[0].attributes.properties.map(prop => ts.isJsxAttribute(prop) ? prop.name.getText(source) : 'spread');
    expect(props).not.toContain('size');
    if (className === 'cnc-packet-card__sheet') {
      expect(props).toEqual(['className', 'ghost', 'activeKey', 'onChange']);
    } else {
      expect(props).toEqual(['className', 'defaultActiveKey']);
    }
  });

  it.each([false, true])('removing ignored size/onClick preserves native HTML (open=%s)', open => {
    const render = (legacy: boolean) => renderToStaticMarkup(
      <Collapse {...(legacy ? { size: 'small', onClick: (event: React.MouseEvent) => event.stopPropagation() } : {})} activeKey={open ? ['test'] : []}>
        <Collapse.Panel key="test" header="Тест панель"><span>Тест детали</span></Collapse.Panel>
      </Collapse>,
    );
    expect(render(false)).toBe(render(true));
  });
});
