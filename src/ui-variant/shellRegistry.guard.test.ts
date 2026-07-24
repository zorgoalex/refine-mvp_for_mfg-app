import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('UI shell registry', () => {
  const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
  const registrySource = readFileSync(resolve(__dirname, 'shellRegistry.tsx'), 'utf8');
  const indexSource = readFileSync(resolve(__dirname, '../index.tsx'), 'utf8');

  it('does not statically import either authenticated shell from App', () => {
    expect(appSource).not.toContain('from "./components/workspace/WorkspaceLayout"');
    expect(appSource).not.toContain('from "./ui-evolution/shell/EvolutionWorkspaceLayout"');
    expect(appSource).toContain('<VariantWorkspaceLayout');
  });

  it('keeps both shells behind dynamic import boundaries', () => {
    expect(registrySource).toContain("import('../components/workspace/WorkspaceLayout')");
    expect(registrySource).toContain("import('../ui-evolution/shell/EvolutionWorkspaceLayout')");
    expect(registrySource).toContain('lazy(shellLoaders.legacy)');
    expect(registrySource).toContain('lazy(shellLoaders.evolution)');
  });

  it('sets the root marker before importing App', () => {
    expect(indexSource).toContain('seedLegacyAuthSession()');
    expect(indexSource.indexOf('seedLegacyAuthSession()')).toBeLessThan(
      indexSource.indexOf('await resolveInitialUiVariant'),
    );
    expect(indexSource.indexOf('setDocumentUiVariant(uiVariant)')).toBeLessThan(
      indexSource.indexOf('await import("./App")'),
    );
  });
});
