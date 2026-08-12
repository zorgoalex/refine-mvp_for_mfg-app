import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const indexSource = readFileSync(resolve(__dirname, 'index.tsx'), 'utf8');
const errorBoundarySource = readFileSync(
  resolve(__dirname, 'components/ErrorBoundary.tsx'),
  'utf8',
);

describe('stale chunk recovery wiring', () => {
  it('recovers bootstrap App chunk failures before React mounts', () => {
    expect(indexSource).toContain('reloadPageOnceForStaleChunk');
    expect(indexSource).toMatch(
      /catch\s*\(error\)\s*{[\s\S]*reloadPageOnceForStaleChunk\(error\)[\s\S]*return;[\s\S]*throw error;/,
    );
  });

  it('recovers lazy route chunk failures inside the React error boundary', () => {
    expect(errorBoundarySource).toContain('reloadPageOnceForStaleChunk');
    expect(errorBoundarySource).toMatch(
      /componentDidCatch\(error: Error, errorInfo: ErrorInfo\)[\s\S]*reloadPageOnceForStaleChunk\(error\)[\s\S]*return;/,
    );
  });
});
