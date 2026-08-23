import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(resolve(__dirname, '../pages/orders/show.tsx'), 'utf8');
const registrySource = readFileSync(resolve(__dirname, 'workspaceCheckpointRegistry.ts'), 'utf8');
const uiStoreSource = readFileSync(resolve(__dirname, 'workspaceUiStateStore.ts'), 'utf8');

describe('workspace checkpoint SSE boundary', () => {
  it('keeps transport state out of the order-show checkpoint adapter', () => {
    const adapterStart = showSource.indexOf("useWorkspaceCheckpointAdapter(tabKey, 'order-show'");
    const adapterEnd = showSource.indexOf('useLayoutEffect(() => restoreWorkspaceDomCheckpoint', adapterStart);
    const adapter = showSource.slice(adapterStart, adapterEnd);

    expect(adapterStart).toBeGreaterThan(-1);
    expect(adapter).not.toMatch(/streamCursor|etag|reconnect|parser|transport|orderRealtime/i);
  });

  it('does not give checkpoint infrastructure ownership of SSE transport', () => {
    expect(registrySource).not.toMatch(/orderRealtime|EventSource|streamCursor|Last-Event-ID/);
    expect(uiStoreSource).not.toMatch(/orderRealtime|EventSource|streamCursor|Last-Event-ID/);
  });
});
