import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, 'workspaceDomCheckpoint.ts'), 'utf8');
const draggable = readFileSync(
  resolve(__dirname, '../components/DraggableModalWrapper.tsx'),
  'utf8',
);
const reactTracker = readFileSync(
  resolve(__dirname, 'workspaceDomCheckpointReact.ts'),
  'utf8',
);

describe('workspace DOM checkpoint source contract', () => {
  it('owns both route roots and Ant modal portals by the exact workspace key', () => {
    expect(source).toContain("'[data-workspace-key], [data-workspace-portal-key]'");
    expect(source).toContain('element.dataset.workspacePortalKey === workspaceKey');
    expect(draggable).toContain('data-workspace-portal-key={workspaceKey}');
  });

  it('restores raw input and cursor without dispatching input/change/validation', () => {
    expect(source).toContain('element.value = focus.rawValue');
    expect(source).toContain('element.setSelectionRange(start, end)');
    expect(source).not.toContain('dispatchEvent');
    expect(source).not.toContain('validateFields');
  });

  it('tracks the last active interaction before route hide/unmount', () => {
    expect(reactTracker).toContain("'selectionchange'");
    expect(reactTracker).toContain("'pointerup'");
    expect(reactTracker).toContain("window.addEventListener('scroll'");
    expect(reactTracker).toContain('if (!activeRef.current) return');
    expect(reactTracker).toContain('latestRef.current = captureWorkspaceDomCheckpoint');
  });
});
