import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultWriteMappingAgent, onecValueLabel } from './onecWriteMappings';

describe('ERP → 1C write mappings (frontend helpers)', () => {
  it('defaults to the first ACTIVE agent (stage keeps a blocked copy of the production agent)', () => {
    expect(defaultWriteMappingAgent([{ agentId: 'unf-kz-prod-01', status: 'blocked' }, { agentId: 'unf-kz-test-01', status: 'active' }])).toBe('unf-kz-test-01');
    expect(defaultWriteMappingAgent([{ agentId: 'a', status: 'blocked' }])).toBe('a');
    expect(defaultWriteMappingAgent([])).toBe('');
  });

  it('labels the fixed 1C values', () => {
    expect(onecValueLabel('ВРаботе')).toBe('В работе');
    expect(onecValueLabel('ГотовКВыдаче')).toBe('Готов к выдаче');
    expect(onecValueLabel(null)).toBe('— пусто —');
  });
});

describe('«Связи для записи в 1С» guards', () => {
  const page = readFileSync(new URL('./OnecPage.tsx', import.meta.url), 'utf8');
  const tab = readFileSync(new URL('./WriteMappingsTab.tsx', import.meta.url), 'utf8');
  const api = readFileSync(new URL('./onecWriteMappings.ts', import.meta.url), 'utf8');
  it('the tab exists only with onec.write.mappings', () => {
    expect(page).toContain("const canEditWriteMappings = can('onec.write.mappings');");
    expect(page).toMatch(/\.\.\.\(canEditWriteMappings \? \[\{\s*key: 'write-mappings'/);
  });
  it('reads and writes only through the backend mappings API; sends nothing to 1C', () => {
    expect(api).toContain("backendApiPath(`/onec/write-mappings");
    expect(api.match(/httpClient\.(post|put|patch|delete)/g)).toEqual(['httpClient.put']);
    for (const source of [tab, api]) expect(source).not.toMatch(/useList|useMany|dataProvider|onecApi\.|\/commands|enqueue/);
    // Optimistic save: the version the user saw goes with every change.
    expect(tab).toContain('expectedVersion: item.mapping?.version ?? null');
  });
});

describe('«Связи для записи в 1С» tab module', () => {
  it('imports (the module compiles) and exports the tab component', async () => {
    const module = await import('./WriteMappingsTab');
    expect(typeof module.WriteMappingsTab).toBe('function');
  }, 60_000); // antd loads slowly in node
  it('refreshes after a save only for the agent still selected; a switch drops the previous agent data', () => {
    const tab = readFileSync(new URL('./WriteMappingsTab.tsx', import.meta.url), 'utf8');
    expect(tab).toContain('if (savedFor === currentAgent.current) load();');
    expect(tab).toContain('onSaved={() => refreshAfterSave(agentId)}');
    expect(tab).toContain("const kinds = loaded && loaded.agentId === agentId ? loaded.kinds : null;");
    expect(tab).not.toContain('setKinds(');
  });
});
