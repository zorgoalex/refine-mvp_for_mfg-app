import { expect, test, type Locator } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/modalFooterCompatibility.tsx'],
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
  });
  bundle = result.outputFiles[0].text;
});

const cases = {
  sidebar: {
    button: 'Настроить порядок меню',
    initial: { top: ['clients', 'orders'], categories: ['work'], resources: { work: ['clients_resource', 'orders_resource'] } },
    defaults: { top: ['orders', 'clients'], categories: ['work'], resources: { work: ['orders_resource', 'clients_resource'] } },
  },
  columns: {
    button: 'Настроить колонки деталей',
    initial: { order: ['id', 'quantity', 'name'], hidden: ['name'] },
    defaults: { order: ['id', 'name', 'quantity'], hidden: [] },
  },
};

async function assertRows(dialog: Locator, kind: keyof typeof cases, reset: boolean) {
  if (kind === 'sidebar') {
    await expect(dialog.locator('section').first().locator('[draggable]'))
      .toHaveText(reset ? ['Заказы', 'Клиенты'] : ['Клиенты', 'Заказы']);
    await expect(dialog.locator('section').last().locator('[draggable]'))
      .toHaveText(reset ? ['Заказы раздела', 'Клиенты раздела'] : ['Клиенты раздела', 'Заказы раздела']);
  } else {
    await expect(dialog.locator('.ant-checkbox-wrapper'))
      .toHaveText(reset ? ['ID', 'Название', 'Количество'] : ['ID', 'Количество', 'Название']);
    await expect(dialog.getByRole('checkbox', { name: 'ID', exact: true })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'ID', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: 'Название', exact: true })).toBeChecked({ checked: reset });
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 768, height: 1024 }]) {
  test.describe(`${viewport.width}px native footer`, () => {
    test.use({ viewport });
    for (const kind of ['sidebar', 'columns'] as const) {
      test(`${kind}: reset, pending, error, close and persisted reopen`, async ({ page }, testInfo) => {
        const errors: string[] = [];
        const unexpectedRequests: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
          if (route.request().url() === 'http://modal-footer.test/') {
            return route.fulfill({ contentType: 'text/html', body: '<html><body><div id="root"></div></body></html>' });
          }
          unexpectedRequests.push(route.request().url());
          return route.abort();
        });
        await page.goto('http://modal-footer.test/');
        await page.evaluate(value => { window.footerCase = value; }, kind);
        await page.addScriptTag({ content: bundle });
        const entry = cases[kind];
        const open = page.getByRole('button', { name: entry.button, exact: true });
        const persisted = page.getByTestId('persisted');
        await expect(persisted).toHaveText(JSON.stringify(entry.initial));
        await open.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible();
        await assertRows(dialog, kind, false);
        await page.screenshot({ path: testInfo.outputPath('initial.png') });
        const reset = dialog.getByRole('button', { name: 'Сбросить по умолчанию', exact: true });
        const close = dialog.getByRole('button', { name: 'Закрыть', exact: true });
        await expect(reset).toBeVisible();
        await expect(close).toBeVisible();
        await expect(dialog.getByText('Сохраняется автоматически', { exact: true })).toBeVisible();
        const footer = dialog.locator('.ant-modal-footer');
        expect(await footer.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        const resetBox = (await reset.boundingBox())!;
        const closeBox = (await close.boundingBox())!;
        expect(resetBox.x).toBeGreaterThanOrEqual(0);
        expect(resetBox.x + resetBox.width).toBeLessThanOrEqual(closeBox.x);
        expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(viewport.width);
        expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(viewport.height);

        await reset.click();
        await expect(dialog.getByText('Сохранение...', { exact: true })).toBeVisible();
        await assertRows(dialog, kind, true);
        expect(await page.evaluate(() => window.footerCalls)).toEqual([entry.defaults]);
        await expect(persisted).toHaveText(JSON.stringify(entry.initial));
        await page.evaluate(() => window.rejectFooterSave());
        await expect(dialog.getByText('Ошибка сохранения', { exact: true })).toBeVisible();
        await expect(persisted).toHaveText(JSON.stringify(entry.initial));
        await close.click();
        await expect(dialog).not.toBeVisible();
        await open.click();
        await assertRows(dialog, kind, false);

        await reset.click();
        await expect(dialog.getByText('Сохранение...', { exact: true })).toBeVisible();
        await page.evaluate(() => window.resolveFooterSave());
        await expect(dialog.getByText('Сохраняется автоматически', { exact: true })).toBeVisible();
        await expect(persisted).toHaveText(JSON.stringify(entry.defaults));
        await close.click();
        await expect(dialog).not.toBeVisible();
        await open.click();
        await assertRows(dialog, kind, true);
        await page.screenshot({ path: testInfo.outputPath('saved-reopen.png') });
        expect(await page.evaluate(() => window.footerCalls)).toEqual([entry.defaults, entry.defaults]);
        expect(unexpectedRequests).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  });
}
