import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('./useDragSelection.ts', import.meta.url)),
  'utf8',
);

describe('useDragSelection interaction performance guards', () => {
  it('does not enter React drag state on an ordinary mouse down', () => {
    const handlerStart = source.indexOf('const handleMouseDown = useCallback');
    const handlerEnd = source.indexOf('// Confirm pending selection', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler).toContain('pendingDragRef.current = {');
    expect(handler).not.toContain('setIsDragging(true)');
    expect(handler).not.toContain('setPendingKeys([])');
  });

  it('activates drag only after a movement threshold', () => {
    expect(source).toContain('const DRAG_ACTIVATION_DISTANCE_PX = 5;');
    expect(source).toContain('if (distance < DRAG_ACTIVATION_DISTANCE_PX) return;');
    expect(source).toContain('setIsDragging(true);');
  });

  it('uses the global pointer lookup instead of per-row mouse-enter handlers', () => {
    expect(source).toContain('updatePendingFromPoint(e.clientX, e.clientY);');
    expect(source).not.toContain('handleMouseEnter');
  });
});
