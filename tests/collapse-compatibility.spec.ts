import { expect, test, type Locator } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({ entryPoints: ['tests/fixtures/collapseCompatibility.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' } });
  bundle = result.outputFiles[0].text;
});
const styles = ['src/styles/app.css', 'src/ui-operational/operational.css', 'src/pages/orderStatusBoard/orderStatusBoard.css'];
const appearance = (root: Locator) => root.locator('.ant-collapse-header').evaluate(element => {
  const css = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  return { width: box.width, height: box.height, padding: css.padding, fontSize: css.fontSize,
    lineHeight: css.lineHeight, border: css.border, background: css.backgroundColor };
});

for (const width of [390, 1280]) {
  for (const className of ['cut-results-history-collapse', 'cut-page-modern__details', 'cnc-packet-card__sheet']) {
    test(`${className} ${width}px: size removal preserves layout and toggling`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url() === 'http://collapse.test/'
        ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
      await page.goto('http://collapse.test/');
      await page.addStyleTag({ content: styles.map(file => readFileSync(file, 'utf8')).join('\n') });
      await page.addScriptTag({ content: bundle });
      const before = page.getByTestId(`${className}-before`);
      const after = page.getByTestId(`${className}-after`);
      await expect(after.getByRole('button', { name: 'Тест панель' })).toHaveAttribute('aria-expanded', 'false');
      expect(await appearance(after)).toEqual(await appearance(before));
      for (const root of [before, after]) {
        const header = root.getByRole('button', { name: 'Тест панель' });
        await header.click();
        await expect(header).toHaveAttribute('aria-expanded', 'true');
        await expect(root.getByText('Тест детали')).toBeVisible();
        await expect(root.getByTestId('changes')).toHaveText('1');
        await header.press('Enter');
        await expect(header).toHaveAttribute('aria-expanded', 'false');
        await expect(root.getByText('Тест детали')).toBeHidden();
        await expect(root.getByTestId('changes')).toHaveText('2');
        // Installed rc-collapse does not forward root onClick. Characterize the
        // existing behavior on BOTH sides; fixing propagation is separate scope.
        await expect(root.getByTestId('parent-clicks')).toHaveText('1');
        await expect(root.getByTestId('collapse-clicks')).toHaveText('0');
      }
      expect(await appearance(after)).toEqual(await appearance(before));
      expect(errors).toEqual([]);
    });
  }
}
