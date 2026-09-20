import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { resolveDetailMaterialName, resolveHeaderMaterialName } from '../../utils/materialDisplayName';
import { resolveOrderExportClientName, toOrderExportClient } from './utils/orderExportClient';

// Execute the actual page's pure memo expression, without mounting its unrelated
// queries/navigation. This intentionally guards the production callback, not a
// second implementation of its deduplication/fallback rules.
const source = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('show.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression: ts.Expression | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'headerMaterialNames') {
    expression = node.initializer;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!expression) throw new Error('Missing headerMaterialNames page memo');
const body = ts.transpileModule(`return ${expression.getText(ast)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const compute = new Function('useMemo', 'details', 'resolvedNameByDetailId', 'materialsMap', 'materialsData', 'resolveDetailMaterialName', body);

describe('order show display contracts', () => {
  it('deduplicates backend material names while preserving first appearance', () => {
    expect(compute((fn: () => unknown) => fn(), [
      { materialName: 'Тест B' }, { materialName: 'Тест A' }, { materialName: 'Тест B' },
      { materialName: null }, { materialName: ' ' },
    ], new Map(), new Map(), undefined, resolveDetailMaterialName)).toEqual(['Тест B', 'Тест A']);
  });

  it('preserves legacy resolved-name priority, fallback and original text', () => {
    expect(compute((fn: () => unknown) => fn(), [
      { detail_id: 1, material_id: 5, material_name: 'ignored' },
      { detail_id: 2, material_id: 5 },
      { material_name_resolved: ' Тест saved ' },
    ], new Map([[1, 'Тест resolved']]), new Map([[5, 'Тест legacy']]), undefined,
    resolveDetailMaterialName)).toEqual(['Тест resolved', 'Тест legacy', ' Тест saved ']);
  });

  it.each([[], null, undefined])('returns an empty material list without details: %s', (details) => {
    expect(compute((fn: () => unknown) => fn(), details, new Map(), new Map(), undefined, resolveDetailMaterialName)).toEqual([]);
  });

  it('preserves header-only material fallback and priority', () => {
    expect(resolveHeaderMaterialName({ material_name_resolved: 'Тест saved', material_name: 'Тест server' })).toBe('Тест saved');
    expect(resolveHeaderMaterialName({ material_name: ' ', headerMaterialName: 'Тест backend' })).toBe('Тест backend');
    expect(resolveHeaderMaterialName(undefined)).toBeNull();
  });

  it('resolves client name across record, backend and legacy client query', () => {
    expect(resolveOrderExportClientName({ clientName: ' Тест record ' }, { header: { clientName: 'Тест backend' } }, { client_name: 'Тест legacy' })).toBe('Тест record');
    expect(resolveOrderExportClientName({}, { header: { clientName: 'Тест backend' } }, { client_name: 'Тест legacy' })).toBe('Тест backend');
    expect(resolveOrderExportClientName({}, {}, { client_name: ' Тест legacy ' })).toBe('Тест legacy');
  });

  it('does not stringify non-text client values or synthesize an empty export client', () => {
    expect(resolveOrderExportClientName({ client_name: 123 }, { header: { clientName: false } }, { client_name: null })).toBeNull();
    expect(toOrderExportClient(null)).toBeNull();
    expect(toOrderExportClient('Тест')).toEqual({ client_name: 'Тест' });
  });
});
