import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ['tests/fixtures/quickCreateCollapse.tsx'], bundle: true, write: false,
    format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
  });
  bundle = result.outputFiles[0].text;
});

for (const kind of ['edge', 'milling']) {
  for (const scenario of ['default', 'edit', 'restore', 'cancel', 'retry', 'pending']) {
    test(`native ${kind} quick-create: ${scenario}`, async ({ page }) => {
      await page.setViewportSize({ width: scenario === 'edit' ? 390 : 1280, height: 900 });
      const calls: Array<{ resource: string; variables: Record<string, unknown> }> = [];
      const unexpected: string[] = [];
      const errors: string[] = [];
      let releaseCreate: () => void = () => {};
      const pendingCreate = new Promise<void>(resolve => { releaseCreate = resolve; });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'quick-create.test' && url.pathname === '/') {
          return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
        }
        if (url.hostname === 'quick-create.test' && url.pathname === '/create' && route.request().method() === 'POST') {
          calls.push(route.request().postDataJSON());
          if (scenario === 'pending') await pendingCreate;
          if (scenario === 'retry' && calls.length === 1) return route.fulfill({ status: 500, json: {} });
          return route.fulfill({ json: { edge_type_id: 42, milling_type_id: 42 } });
        }
        unexpected.push(url.href);
        return route.abort();
      });
      await page.goto(`http://quick-create.test/?kind=${kind}${scenario === 'restore' ? '&restore=1' : ''}`);
      await page.addScriptTag({ content: bundle });
      const modal = page.getByRole('dialog');
      const name = modal.getByLabel('Название типа');
      const header = modal.getByRole('button', { name: /Порядок сортировки/ });
      const sort = modal.locator('#sort_order');
      const submit = modal.locator('.ant-modal-footer').getByRole('button', { name: /Создать$/ });
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute('aria-expanded', 'false');
      await expect(sort).not.toBeVisible();
      if (scenario === 'restore') {
        await expect(name).toHaveValue('Восстановленный тип');
      } else {
        await submit.click();
        await expect(modal.getByText('Обязательное поле')).toBeVisible();
        expect(calls).toEqual([]);
        await name.fill('  Тестовый тип  ');
      }
      if (scenario === 'edit' || scenario === 'cancel') {
        if (kind === 'milling' && scenario === 'edit') await modal.getByLabel('Цена за кв.м.').fill('12.50');
        await header.click();
        await expect(sort).toHaveValue('100');
        await sort.fill('37');
        await header.click();
        await expect(sort).not.toBeVisible();
      }
      if (scenario === 'cancel') {
        await modal.getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(modal).not.toBeVisible();
        expect(calls).toEqual([]);
        await page.getByRole('button', { name: 'Открыть тестовую форму' }).click();
        await expect(name).toHaveValue('');
        await name.fill('  Тестовый тип  ');
      }
      await submit.click();
      if (scenario === 'pending') {
        await expect(submit).toHaveClass(/ant-btn-loading/);
        await expect.poll(() => calls.length).toBe(1);
        // Native AntD ignores activation while confirmLoading is true.
        await submit.evaluate((button: HTMLButtonElement) => button.click());
        expect(calls).toHaveLength(1);
        releaseCreate();
      }
      if (scenario === 'retry') {
        await expect(page.getByText('Тестовая ошибка API')).toBeVisible();
        await expect(modal).toBeVisible();
        await expect(name).toHaveValue('  Тестовый тип  ');
        await submit.click();
      }
      await expect(page.getByTestId('saved')).toHaveText('[42]');
      await expect(modal).not.toBeVisible();
      expect(calls).toHaveLength(scenario === 'retry' ? 2 : 1);
      for (const call of calls) {
        expect(call).toEqual({
          resource: kind === 'edge' ? 'edge_types' : 'milling_types',
          variables: {
            [kind === 'edge' ? 'edge_type_name' : 'milling_type_name']: scenario === 'restore' ? 'Восстановленный тип' : 'Тестовый тип',
            sort_order: scenario === 'restore' || scenario === 'edit' ? 37 : 100,
            is_active: true,
            ...(kind === 'milling' ? { cost_per_sqm: scenario === 'edit' ? 12.5 : null } : {}),
          },
        });
      }
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  }
}
