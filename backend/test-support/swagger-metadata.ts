import ts from 'typescript';

function decorators(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

function call(decorator: ts.Decorator, name: string): ts.CallExpression | undefined {
  const expression = decorator.expression;
  return ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
    && expression.expression.text === name ? expression : undefined;
}

const httpMethods = ['Get', 'Post', 'Put', 'Patch', 'Delete', 'Head', 'Options', 'All'];

export function inspectSwaggerMetadata(source: string) {
  const file = ts.createSourceFile('controller.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const missingTags: string[] = [];
  const missingOperations: string[] = [];
  let controllerCount = 0;

  for (const declaration of file.statements) {
    if (!ts.isClassDeclaration(declaration)) continue;
    const classDecorators = decorators(declaration);
    if (!classDecorators.some((decorator) => call(decorator, 'Controller'))) continue;
    controllerCount += 1;
    const excluded = classDecorators.map((decorator) => call(decorator, 'ApiExcludeController')).find(Boolean);
    // Nest treats omitted argument as true; explicit false keeps the controller public.
    if (excluded && (excluded.arguments.length === 0 || excluded.arguments[0].kind === ts.SyntaxKind.TrueKeyword)) continue;
    const className = declaration.name?.text ?? '<anonymous>';
    if (!classDecorators.some((decorator) => call(decorator, 'ApiTags'))) missingTags.push(className);

    for (const member of declaration.members) {
      if (!ts.isMethodDeclaration(member)) continue;
      const methodDecorators = decorators(member);
      const route = methodDecorators.find((decorator) => httpMethods.some((name) => call(decorator, name)));
      if (!route) continue;
      if (!methodDecorators.some((decorator) => call(decorator, 'ApiOperation'))) {
        const line = file.getLineAndCharacterOfPosition(route.getStart(file)).line + 1;
        missingOperations.push(`${className}.${member.name.getText(file)}:${line}:${route.getText(file)}`);
      }
    }
  }
  return { controllerCount, missingTags, missingOperations };
}
