import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const validCases = [
  "const keys: readonly Key[] = Object.freeze([1, '1', 1n]);",
  'const state: GroupCheckboxState = groupCheckboxState(keys, keys);',
  'const toggled: Key[] = toggleGroupSelection(keys, keys);',
  'const ids: number[] = selectedDetailIds([{ temp_id: 1n, detail_id: 42 }], keys);',
  'const numeric: number[] = filterNumericKeys(keys);',
];
const invalidCases = [
  ['object key', 'toggleGroupSelection([{}], keys);'],
  ['boolean key', 'filterNumericKeys([false]);'],
  ['null key', 'groupCheckboxState([null], keys);'],
  ['non-numeric business IDs', 'const wrongIds: bigint[] = selectedDetailIds([], keys);'],
] as const;

describe('group selection type contract', () => {
  let diagnostics: { line: number; message: string }[];
  beforeAll(() => {
    const file = path.resolve('src/pages/orders/__group_selection_type_probe__.ts');
    const source = [
      "import type { Key } from 'react';",
      "import { groupCheckboxState, toggleGroupSelection, selectedDetailIds, filterNumericKeys, type GroupCheckboxState } from './groupSelection';",
      ...validCases,
      ...invalidCases.map(([, expression]) => expression),
    ].join('\n');
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, types: [],
    };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = name => name === file ? source : readFile(name);
    host.fileExists = name => name === file || fileExists(name);
    diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host)).map(diagnostic => ({
      line: diagnostic.file?.fileName === file
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!).line : -1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  }, 60_000);

  it('accepts readonly React.Key arrays while keeping persisted IDs numeric', () => {
    expect(diagnostics.filter(diagnostic => diagnostic.line < 2 + validCases.length)).toEqual([]);
  });

  it.each(invalidCases)('rejects %s', name => {
    const line = 2 + validCases.length + invalidCases.findIndex(([key]) => key === name);
    expect(diagnostics.filter(diagnostic => diagnostic.line === line).length).toBeGreaterThan(0);
  });
});
