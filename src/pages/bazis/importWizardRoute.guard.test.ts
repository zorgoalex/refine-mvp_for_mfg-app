import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wizard = readFileSync(resolve(process.cwd(), 'src/pages/bazis/ImportWizardModal.tsx'), 'utf8');

/**
 * The route of a Bazis XML import is fixed at its first attempt together with its idempotency key: a retry after a lost
 * answer never goes to the legacy route (a second XML project), and a background capability change does not restart a
 * running import (its answer is not dropped).
 */
describe('Bazis XML import route', () => {
  it('is chosen once per import and reset only with a new key', () => {
    expect(wizard).toContain("importRouteRef.current ??= cardsSupportedRef.current ? 'cards' : 'legacy';");
    expect(wizard).toContain("legacy: importRouteRef.current === 'legacy',");
    expect(wizard).toMatch(/setImportKey\(`bazis-import:\$\{createWizardUuid\(\)\}`\);\s+importRouteRef\.current = null;/);
  });

  it('does not depend on the live capability in the import effect', () => {
    const deps = wizard.slice(wizard.indexOf('importLoading/onImported сознательно НЕ в deps'));
    expect(deps.slice(0, deps.indexOf(']);'))).not.toContain('cardsSupported');
  });

  it('refuses an import into a card on the legacy route (an older backend) instead of losing the card', () => {
    expect(wizard).toContain("if (importRouteRef.current === 'legacy' && dowelingOrderId != null) {");
  });

  it('the card block keeps its wizard mounted when the capability changes (a running import keeps its key)', () => {
    const block = readFileSync(resolve(process.cwd(), 'src/pages/doweling_orders/CardXmlBlock.tsx'), 'utf8');
    expect(block).toContain("const visible = featureFlags.useBackendBazis && can('bazis.view');");
    expect(block).toContain("{can('bazis.manage') && cardsSupported ? (");
    // A list asked before the capability turned out «no» is dropped, and only this card's XML projects are shown (R5 #2).
    expect(block).toContain('if (seq === requestSeq.current) setProjects(listed.filter((project) => project.card?.dowelingOrderId === dowelingOrderId));');
    expect(block).toMatch(/if \(!visible \|\| !cardsSupported\) \{\s+setProjects\(\[\]\);/);
    expect(block).toContain('{!cardsSupported ? (');
    const hook = readFileSync(resolve(process.cwd(), 'src/hooks/useBazisCardsCapability.ts'), 'utf8');
    expect(hook).toContain("error?.status === 404 ? false : cached?.value ?? true");
  });
});
