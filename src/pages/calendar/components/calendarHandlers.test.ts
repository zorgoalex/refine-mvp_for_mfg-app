import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the real component handler, without replacing it with a test copy or
// mounting the unrelated data-fetching/drag-and-drop tree in this unit test.
function componentHandler(file: string, name: string, bindings: Record<string, unknown>) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!initializer || !ts.isArrowFunction(initializer)) throw new Error(`Missing real handler: ${file}:${name}`);
  const compiled = ts.transpileModule(`const handler = ${initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(bindings), `${compiled}\nreturn handler;`)(...Object.values(bindings));
}

describe('CalendarBoard context-menu close handler', () => {
  it.each([
    [false, 'right'], [false, 'left'], [true, 'right'], [true, 'left'],
  ])('preserves layout and selected order: compact=%s, direction=%s', (compact, submenuDirection) => {
    const order = { order_id: 201 };
    const original = Object.freeze({ visible: true, x: 120, y: 80, compact, submenuDirection, order });
    let state = original;
    const close = componentHandler('./CalendarBoard.tsx', 'handleCloseContextMenu', {
      setContextMenu: (update: (previous: typeof original) => typeof original) => { state = update(state); },
    });
    close();
    expect(state).toEqual({ ...original, visible: false, x: 0, y: 0 });
    expect(state.order).toBe(order); // Keeps OrderContextMenu and its move-date modal mounted.
    expect(original.visible).toBe(true);
    state = { ...state, visible: true, x: 50, y: 70 };
    close();
    expect(state).toEqual({ ...original, visible: false, x: 0, y: 0 });
  });
});

describe('OrderCard native checkbox handler', () => {
  it.each([true, false])('stops propagation and forwards checked=%s with the same order', checked => {
    const calls: string[] = [];
    const order = { order_id: 201 };
    const onCheckboxChange = vi.fn(() => { calls.push('change'); });
    const change = componentHandler('./OrderCard.tsx', 'handleCheckboxChange', { order, onCheckboxChange });
    change({ target: { checked }, stopPropagation: () => { calls.push('stop'); } });
    expect(onCheckboxChange).toHaveBeenCalledExactlyOnceWith(order, checked);
    expect(calls).toEqual(['stop', 'change']);
  });

  it('still stops propagation without an optional callback', () => {
    const stopPropagation = vi.fn();
    const change = componentHandler('./OrderCard.tsx', 'handleCheckboxChange', { order: { order_id: 201 }, onCheckboxChange: undefined });
    change({ target: { checked: true }, stopPropagation });
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
