import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Read the real JSX props so browser checks cannot silently test copied styles.
export const bodyStyleCases = [
  { name: 'image preview', file: 'src/components/ImagePrintPreviewModal.tsx', tag: 'Modal', expected: { padding: 0 } },
  { name: 'mobile navigation', file: 'src/components/MobileSiderDrawer.tsx', tag: 'Drawer', expected: { padding: 0 } },
  { name: 'label editor', file: 'src/pages/configuration/components/LabelsConfigTab.tsx', tag: 'Modal', expected: { maxHeight: '72vh', overflowY: 'auto' } },
  { name: 'PDF import', file: 'src/pages/orders/components/import/PdfImportModal.tsx', tag: 'Modal', expected: { minHeight: 500, maxHeight: 'calc(90vh - 120px)', overflow: 'hidden', display: 'flex', flexDirection: 'column' } },
  { name: 'photo import', file: 'src/pages/orders/components/import/VlmImportModal.tsx', tag: 'Modal', expected: { overflow: 'hidden', display: 'flex', flexDirection: 'column' } },
  { name: 'Telegram preview', file: 'src/pages/orders/components/sections/OrderTelegramScreenshots.tsx', tag: 'Modal', expected: { padding: 0 } },
] as const;

function readLiteral(node: ts.Expression): unknown {
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(node.properties.map((property) => {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
        throw new Error('Expected a literal style property');
      }
      return [property.name.text, readLiteral(property.initializer)];
    }));
  }
  throw new Error('Expected a static body style, not executable code');
}

export function readBodyStyleProps(file: string, tag: string): Record<string, unknown> {
  const source = ts.createSourceFile(file, readFileSync(path.resolve(file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: Record<string, unknown>[] = [];
  function visit(node: ts.Node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === tag) {
      const props: Record<string, unknown> = {};
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = attr.name.getText(source);
        if (name !== 'styles' && name !== 'bodyStyle') continue;
        if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) {
          throw new Error('Expected a JSX style expression');
        }
        props[name] = readLiteral(attr.initializer.expression);
      }
      if (Object.keys(props).length) matches.push(props);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (matches.length !== 1) throw new Error(`${file}: expected exactly one styled ${tag}, got ${matches.length}`);
  return matches[0];
}
