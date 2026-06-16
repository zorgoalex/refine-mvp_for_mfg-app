import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'ValidationStep.tsx'), 'utf8');

// Guard: the cell editors must stay declared at module scope (stable identity),
// not re-created inside the component (e.g. via useCallback). Inline definitions
// get a new identity every render, remounting the editors and losing input focus.
describe('ValidationStep editors stay at module scope', () => {
  const editors = ['NumberEditor', 'TextEditor', 'RefSelectEditor', 'StatusIcon'];

  it('declares each editor as a module-level React.FC component', () => {
    for (const name of editors) {
      expect(source).toContain(`const ${name}: React.FC`);
    }
  });

  it('does not re-create the editors inside the component via useCallback', () => {
    for (const name of editors) {
      expect(source).not.toContain(`const ${name} = useCallback`);
      expect(source).not.toContain(`${name} = useCallback`);
    }
  });

  it('keeps the editors above the ValidationStep component (module scope, not nested)', () => {
    const componentIdx = source.search(/(export\s+(const|function)\s+ValidationStep\b)/);
    expect(componentIdx).toBeGreaterThan(-1);
    for (const name of editors) {
      const editorIdx = source.indexOf(`const ${name}: React.FC`);
      expect(editorIdx).toBeGreaterThan(-1);
      expect(editorIdx).toBeLessThan(componentIdx);
    }
  });
});
