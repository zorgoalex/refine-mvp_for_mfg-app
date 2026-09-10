import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const validCases = [
  "const basic = <Segmented options={['Тест', 2]} />;",
  "const controlled = <Segmented options={['Тест', 2]} value={2} onChange={value => { const typed: string | number = value; }} />;",
  "const uncontrolled = <Segmented options={[1, 2]} defaultValue={1} />;",
  'const labeled = <Segmented options={[{value: "Тест", label: <strong>Тест</strong>, disabled: true}, {value: 2, icon: <span>2</span>}]} />;',
  'const presentation = <Segmented options={[]} block disabled size="large" className="test" style={{width: 200}} aria-label="Тест" />;',
  'const reference = <Segmented options={[]} ref={React.createRef<HTMLDivElement>()} onFocus={event => { const element: HTMLDivElement = event.currentTarget; }} />;',
];
const invalidCases = [
  ['missingOptions', 'const missingOptions = <Segmented />;'],
  ['wrongOptions', 'const wrongOptions = <Segmented options={[true]} />;'],
  ['wrongValue', 'const wrongValue = <Segmented options={[]} value={{bad: true}} />;'],
  ['wrongDefault', 'const wrongDefault = <Segmented options={[]} defaultValue={false} />;'],
  ['wrongHandler', 'const wrongHandler = <Segmented options={[]} onChange={(value: boolean) => {}} />;'],
  ['wrongRef', 'const wrongRef = <Segmented options={[]} ref={React.createRef<HTMLButtonElement>()} />;'],
  ['unknownProp', 'const unknownProp = <Segmented options={[]} unsupported />;'],
  ['wrongSize', 'const wrongSize = <Segmented options={[]} size="huge" />;'],
] as const;

describe('Segmented public type contract', () => {
  let diagnostics: { line: number; message: string }[];
  beforeAll(() => {
    // Compile in memory: Vitest transpilation alone cannot verify type safety.
    const file = path.resolve('src/ui/__segmented_type_probe__.tsx');
    const source = [
      "import * as React from 'react';",
      "import { Segmented } from './Segmented';",
      ...validCases,
      ...invalidCases.map(([, expression]) => expression),
    ].join('\n');
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
      strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, types: [],
    };
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.readFile = name => name === file ? source : readFile(name);
    host.fileExists = name => name === file || fileExists(name);
    const program = ts.createProgram([file], options, host);
    diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => ({
      line: diagnostic.file?.fileName === file
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!).line : -1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  }, 60_000);

  it('accepts supported props without phantom DOM handlers or declaration errors', () => {
    expect(diagnostics.filter(diagnostic => diagnostic.line < 2 + validCases.length)).toEqual([]);
  });

  it.each(invalidCases)('rejects %s', (name) => {
    const line = 2 + validCases.length + invalidCases.findIndex(([key]) => key === name);
    const errors = diagnostics.filter(diagnostic => diagnostic.line === line);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map(error => error.message).join('\n')).not.toMatch(/onResize|onPointerEnterCapture|onPointerLeaveCapture/);
  });
});
