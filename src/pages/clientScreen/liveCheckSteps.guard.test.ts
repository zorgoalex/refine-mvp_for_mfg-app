import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The live check runs against an organisation's own settings and must not expect what is not
 * ticked. This guard reads the script: every expectation about the detail list, tab switches, the
 * HDF tab and the view page sits behind the tick it depends on.
 */
const script = readFileSync(new URL('../../../tests/client-screen-manager-live.mjs', import.meta.url), 'utf8');

describe('live check follows the ticks in force', () => {
  it('writes nothing when the organisation already uses the customer screen', () => {
    expect(script).toContain("const readOnly = original.enabled === true && process.env.CHANGE_SETTINGS !== '1';");
    const write = script.indexOf("settingsRequest('PUT', { enabled: true");
    expect(script.lastIndexOf('if (readOnly) {', write)).toBeGreaterThan(0);
    expect(script.slice(script.lastIndexOf('if (readOnly) {', write), write)).toContain('} else {');
    expect(script).toContain("if (process.env.ROLLBACK === '1' && !readOnly) {");
  });

  it('a tab that is off hides its columns: a column is expected only together with its tab', () => {
    // Parent off, child kept ticked (the settings form keeps such ticks): nothing of the list is expected.
    expect(script).toContain("if (!has('tab.details')) skipped('the detail list and everything on it');");
    expect(script).toContain("if (has('tab.details') && has('details.quantity')) assert.ok(viewHeaders.includes('Кол-во')");
    const details = script.indexOf("else if (await managerTab(/Детали заказа|Состав/).count()) {");
    const quantity = script.indexOf("if (codes.includes('details.quantity')) assert.ok(headers.includes('Кол-во')");
    expect(details).toBeGreaterThan(0);
    expect(quantity).toBeGreaterThan(details);
  });

  it('a tab that is on without any field ticked is expected empty', () => {
    expect(script).toContain("if (codes.some((code) => code.startsWith('basic.'))) await expect(popup.locator('.client-screen__field').first()).toBeVisible();");
    expect(script).toContain("else await expect(popup.locator('.client-screen__field')).toHaveCount(0);");
  });

  it('what is not exercised is reported, never silently skipped', () => {
    for (const reported of ["skipped('the materials tab');", "skipped('the HDF tab');", "skipped('the HDF tab (needs the basic and finance tabs to return to)');",
      "skipped('live edit of a cell (the height column)');", "skipped('tab switches between «Финансы» and «Основная информация»');",
      "skipped('the detail list of the view page');", "skipped('the finance panel of the view page');"]) expect(script, reported).toContain(reported);
  });
});
