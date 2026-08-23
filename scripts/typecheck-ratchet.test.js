import { describe, expect, it } from 'vitest';
import {
  compareDiagnosticCounts,
  countDiagnostics,
  diagnosticKey,
  groupDiagnosticCountsByFamily,
} from './typecheck-ratchet.mjs';

function diagnostic(fileName, code, messageText) {
  return {
    code,
    messageText,
    file: fileName ? { fileName } : undefined,
  };
}

describe('typecheck ratchet', () => {
  it('uses stable keys without source positions', () => {
    const item = diagnostic('/repo/src/App.tsx', 2304, 'Cannot find name');
    item.start = 42;
    item.length = 5;

    expect(diagnosticKey(item, '/repo')).toBe('src/App.tsx|TS2304|Cannot find name');
  });

  it('removes the checkout path from diagnostic messages', () => {
    const item = diagnostic(
      '/repo/src/App.tsx',
      2339,
      'Property does not exist on import("/repo/src/dependency")',
    );

    expect(diagnosticKey(item, '/repo')).toBe(
      'src/App.tsx|TS2339|Property does not exist on import("<root>/src/dependency")',
    );
  });

  it('counts duplicate diagnostics and sorts keys', () => {
    const counts = countDiagnostics([
      diagnostic('/repo/src/B.tsx', 2, 'B'),
      diagnostic('/repo/src/A.tsx', 1, 'A'),
      diagnostic('/repo/src/A.tsx', 1, 'A'),
    ], '/repo');

    expect(counts).toEqual({
      'src/A.tsx|TS1|A': 2,
      'src/B.tsx|TS2|B': 1,
    });
  });

  it('allows removals and reports only added diagnostic counts', () => {
    expect(compareDiagnosticCounts(
      { existing: 1, new: 2 },
      { existing: 2 },
    )).toEqual({
      added: [{ key: 'new', count: 2 }],
      removed: [{ key: 'existing', count: 1 }],
    });
  });

  it('groups reworded diagnostics by stable file and code', () => {
    expect(groupDiagnosticCountsByFamily({
      'src/App.tsx|TS2322|old wording': 1,
      'src/App.tsx|TS2322|new wording': 2,
      'src/App.tsx|TS2339|another error': 1,
    })).toEqual({
      'src/App.tsx|TS2322': 3,
      'src/App.tsx|TS2339': 1,
    });
  });
});
