import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shouldUseNativeTabStripScroll } from './useNativeWorkspaceTabScroll';

describe('workspace tab strip: native finger scroll on a phone', () => {
  it('ignores non-elements (node test env, document, window)', () => {
    expect(shouldUseNativeTabStripScroll(null)).toBe(false);
    expect(shouldUseNativeTabStripScroll({} as EventTarget)).toBe(false);
  });

  it('is wired into both tab bars and the phone strip scrolls in one row', () => {
    const evo = readFileSync('src/ui-evolution/shell/EvolutionWorkspaceTabs.tsx', 'utf8');
    const legacy = readFileSync('src/components/workspace/WorkspaceTabs.tsx', 'utf8');
    expect(evo).toContain('useNativeWorkspaceTabScroll();');
    expect(legacy).toContain('useNativeWorkspaceTabScroll();');
    const hook = readFileSync('src/hooks/useNativeWorkspaceTabScroll.ts', 'utf8');
    expect(hook).toContain("document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });");
    expect(hook).toContain("target.closest('.workspace-tabs .ant-tabs-nav-wrap')");
    const css = readFileSync('src/ui-evolution/styles/workbench-mobile.css', 'utf8');
    expect(css).toMatch(/\.evolution-shell--wb-phone \.evolution-workspace-tabs\.workspace-tabs \.ant-tabs-nav-wrap \{\s*overflow-x: auto !important;/);
    expect(css).toMatch(/\.evolution-shell--wb-phone \.evolution-workspace-tabs\.workspace-tabs \.ant-tabs-nav-list \{\s*flex-wrap: nowrap;/);
  });
});
