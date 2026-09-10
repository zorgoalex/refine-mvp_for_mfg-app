import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { popconfirmCases, readPopconfirmAttributes } from './helpers/popconfirmCases';

let bundle: string;
test.beforeAll(async () => {
  const titles = popconfirmCases.map(entry => {
    const props = readPopconfirmAttributes(entry.file, entry.index);
    if (props.description) throw new Error(`${entry.file}: unsupported Popconfirm.description`);
    return props.title;
  });
  const result = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Button, Popconfirm } from 'antd';
        import { Tooltip } from './src/ui/tooltipDelay';
        import { PopconfirmContent } from './src/components/PopconfirmContent';
        const record = {name: window.testName || 'Тест'};
        const row = record;
        const header = {order_name: record.name};
        const titles = [${titles.join(',\n')}];
        window.confirmCalls = 0;
        window.cancelCalls = 0;
        function App() {
          const [disabled, setDisabled] = React.useState(false);
          const confirm = () => {
            window.confirmCalls++;
            if (window.asyncConfirm) return new Promise((resolve, reject) => {
              window.resolveConfirm = resolve;
              window.rejectConfirm = () => reject(new Error('Тест: отказ API'));
            });
          };
          const button = <Button>Тест: открыть</Button>;
          return <div style={{padding: 16, paddingTop: 80}}>
            <Popconfirm title={titles[window.testCase]} onConfirm={confirm}
              onCancel={() => window.cancelCalls++} disabled={disabled}
              okText="Подтвердить" cancelText="Отмена" okButtonProps={{danger: true}}>
              {window.withTooltip ? <Tooltip title="Удалить">{button}</Tooltip> : button}
            </Popconfirm>
            <button onClick={() => setDisabled(value => !value)}>Тест: блокировка</button>
          </div>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles[0].text;
});

async function mount(page: Page, index: number, options: Record<string, unknown> = {}) {
  await page.setContent('<div id="root"></div>');
  await page.evaluate(values => Object.assign(window, values), { testCase: index, ...options });
  await page.addScriptTag({ content: bundle });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 720 }]) {
  test.describe(`${viewport.width}px`, () => {
    test.use({ viewport });
    for (const [index, entry] of popconfirmCases.entries()) {
      test(`${entry.name}: actual page title, complete warning, cancel and confirm`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await mount(page, index, { withTooltip: entry.name.startsWith('VLM') || entry.name === 'order compact toolbar' });
        await page.getByRole('button', { name: 'Тест: открыть', exact: true }).click();
        const popup = page.locator('.ant-popconfirm-inner-content');
        await expect(popup).toBeVisible();
        await expect(popup.getByText(entry.title, { exact: true })).toBeVisible();
        await expect(popup.getByText(entry.description, { exact: true })).toBeVisible();
        const box = await popup.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
        expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await popup.getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(popup).not.toBeVisible();
        expect(await page.evaluate(() => ({ confirm: window['confirmCalls'], cancel: window['cancelCalls'] }))).toEqual({ confirm: 0, cancel: 1 });
        await page.getByRole('button', { name: 'Тест: открыть', exact: true }).click();
        await popup.getByRole('button', { name: 'Подтвердить', exact: true }).click();
        await expect(popup).not.toBeVisible();
        expect(await page.evaluate(() => window['confirmCalls'])).toBe(1);
        expect(errors).toEqual([]);
      });
    }

    test('native disabled and Escape behavior is preserved', async ({ page }) => {
      await mount(page, 0);
      await page.getByRole('button', { name: 'Тест: блокировка' }).click();
      await page.getByRole('button', { name: 'Тест: открыть', exact: true }).click();
      await expect(page.locator('.ant-popconfirm-inner-content')).not.toBeVisible();
      await page.getByRole('button', { name: 'Тест: блокировка' }).click();
      await page.getByRole('button', { name: 'Тест: открыть', exact: true }).click();
      await expect(page.locator('.ant-popconfirm-inner-content')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.ant-popconfirm-inner-content')).not.toBeVisible();
      expect(await page.evaluate(() => window['confirmCalls'])).toBe(0);
    });

    test('native async confirmation waits, prevents duplicates and supports retry after rejection', async ({ page }) => {
      const loggedErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on('console', message => { if (message.type() === 'error') loggedErrors.push(message.text()); });
      page.on('pageerror', error => pageErrors.push(error.message));
      await mount(page, 7, { asyncConfirm: true });
      await page.getByRole('button', { name: 'Тест: открыть', exact: true }).click();
      const popup = page.locator('.ant-popconfirm-inner-content');
      // AntD adds the loading icon's accessible name while the promise is pending.
      const confirm = popup.getByRole('button', { name: /Подтвердить$/ });
      await confirm.click();
      await expect(confirm).toHaveClass(/ant-btn-loading/);
      await confirm.click();
      expect(await page.evaluate(() => window['confirmCalls'])).toBe(1);
      await page.evaluate(() => window['rejectConfirm']());
      await expect(confirm).not.toHaveClass(/ant-btn-loading/);
      await expect(popup).toBeVisible();
      // AntD 5.0 catches rejection, logs it, clears loading and keeps the popup open.
      expect(loggedErrors.some(message => message.includes('Тест: отказ API'))).toBe(true);
      await confirm.click();
      expect(await page.evaluate(() => window['confirmCalls'])).toBe(2);
      await page.evaluate(() => window['resolveConfirm']());
      await expect(popup).not.toBeVisible();
      expect(pageErrors).toEqual([]);
    });

    test('unbroken dynamic names wrap without becoming HTML', async ({ page }) => {
      const name = '<img src=x onerror=alert(1)>' + 'ДлинноеИмя'.repeat(30);
      await mount(page, 0, { testName: name });
      await page.getByRole('button', { name: 'Тест: открыть', exact: true }).click();
      const popup = page.locator('.ant-popconfirm-inner-content');
      await expect(popup.getByText(`«${name}» и все его ревизии будут удалены безвозвратно.`, { exact: true })).toBeVisible();
      await expect(popup.locator('img')).toHaveCount(0);
      expect(await popup.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    });
  });
}
