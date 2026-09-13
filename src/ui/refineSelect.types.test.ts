import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const validCases = [
  'interface Row { id: number; title: string }',
  "const result = useSelect<Row>({ resource: 'clients', defaultValue: 7 });",
  'const numeric = <Select<number> {...result.selectProps} value={7} onChange={value => { const id: number = value; }} />;',
  'const stringKey = <Select<string> {...result.selectProps} value="7" onChange={value => { const id: string = value; }} />;',
  'const uncontrolled = <Select<number> {...result.selectProps} defaultValue={7} />;',
  'const multiple = <Select<number[]> {...result.selectProps} mode="multiple" value={[7]} />;',
  'const records: Row[] | undefined = result.queryResult.data?.data;',
  'const defaults: Row[] | undefined = result.defaultValueQueryResult.data?.data;',
];
const invalidCases = [
  ['phantom value', 'result.selectProps.value;'],
  ['phantom defaultValue', 'result.selectProps.defaultValue;'],
  ['phantom onChange', 'result.selectProps.onChange;'],
  ['object for numeric Select', 'const wrongValue = <Select<number> {...result.selectProps} value={{ value: "7", label: "Тест" }} />;'],
  ['wrong query record type', 'const wrongId: string = result.queryResult.data!.data[0].id;'],
] as const;

describe('Refine Select actual return type contract', () => {
  let diagnostics: { line: number; message: string }[];
  beforeAll(() => {
    const file = path.resolve('src/ui/__refine_select_type_probe__.tsx');
    const source = [
      "import { Select } from 'antd';",
      "import { useSelect } from './refineSelect';",
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
    diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([file], options, host)).map(diagnostic => ({
      line: diagnostic.file?.fileName === file
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!).line : -1,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }));
  }, 60_000);

  it('accepts primitive controlled/default values and preserves generic query results', () => {
    expect(diagnostics.filter(diagnostic => diagnostic.line < 2 + validCases.length)).toEqual([]);
  });

  it.each(invalidCases)('rejects %s', name => {
    const line = 2 + validCases.length + invalidCases.findIndex(([key]) => key === name);
    expect(diagnostics.filter(diagnostic => diagnostic.line === line).length).toBeGreaterThan(0);
  });
});
