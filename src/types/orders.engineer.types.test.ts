import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const validCases = [
  "type EngineerFields = Pick<Order, 'design_engineer_id' | 'design_engineer'>;",
  'const absent: EngineerFields = {};',
  'const missing: EngineerFields = { design_engineer_id: undefined, design_engineer: undefined };',
  'const cleared: EngineerFields = { design_engineer_id: null, design_engineer: null };',
  "const selected: EngineerFields = { design_engineer_id: 7, design_engineer: 'Тест: инженер' };",
  'const id: number | null | undefined = selected.design_engineer_id;',
  'const name: string | null | undefined = selected.design_engineer;',
  "const linked: Pick<NonNullable<OrderDowelingLink['doweling_order']>, keyof EngineerFields> = selected;",
];
const invalidCases = [
  ['string ID', "const wrongId: EngineerFields = { design_engineer_id: '7' };"],
  ['numeric name', 'const wrongName: EngineerFields = { design_engineer: 7 };'],
  ['required ID', 'const requiredId: number = absent.design_engineer_id;'],
  ['unknown field', 'const extra: EngineerFields = { unsupported: true };'],
] as const;

describe('Order engineer view-field type contract', () => {
  let diagnostics: { line: number; message: string }[];
  let firstCaseLine: number;

  beforeAll(() => {
    // Compile the actual field declarations with strict null checks in isolation.
    // The application is non-strict; importing its entire graph would introduce
    // unrelated strict-mode auth diagnostics. The full project has its own ratchet.
    const modelText = readFileSync(path.resolve('src/types/orders.ts'), 'utf8');
    const model = ts.createSourceFile('orders.ts', modelText, ts.ScriptTarget.Latest, true);
    const interfaces = model.statements.filter(ts.isInterfaceDeclaration);
    const order = interfaces.find(node => node.name.text === 'Order');
    const link = interfaces.find(node => node.name.text === 'OrderDowelingLink');
    if (!order || !link) throw new Error('Order and OrderDowelingLink declarations must exist');
    const fields = order.members.filter(member => (
      ts.isPropertySignature(member)
      && ['design_engineer_id', 'design_engineer'].includes(member.name.getText(model))
    ));
    const declarations = [
      `interface Order { ${fields.map(field => field.getText(model)).join(' ')} }`,
      link.getText(model),
    ].join('\n');
    firstCaseLine = declarations.split('\n').length;
    const file = path.resolve('src/types/__order_engineer_type_probe__.ts');
    const source = [
      declarations,
      ...validCases,
      ...invalidCases.map(([, expression]) => expression),
    ].join('\n');
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      esModuleInterop: true,
      types: [],
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

  it('accepts optional/nullable fields matching the linked doweling view', () => {
    expect(diagnostics.filter(diagnostic => diagnostic.line < firstCaseLine + validCases.length)).toEqual([]);
  });

  it.each(invalidCases)('rejects %s', name => {
    const line = firstCaseLine + validCases.length + invalidCases.findIndex(([key]) => key === name);
    expect(diagnostics.filter(diagnostic => diagnostic.line === line).length).toBeGreaterThan(0);
  });
});
