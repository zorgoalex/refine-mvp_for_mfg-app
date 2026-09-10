import { expect, test, type Page } from '@playwright/test';
import { build } from 'esbuild';

let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ConfigProvider, Segmented as Native, theme } from 'antd';
        import { Segmented } from './src/ui/Segmented';
        const config = window.probeConfig;
        window.changes = {native: [], compat: []};
        window.references = {};
        window.sameComponent = Native === Segmented;
        function Control({kind, Component}) {
          const first = config.numeric ? 1 : 'one';
          const second = config.numeric ? 2 : 'two';
          const third = config.numeric ? 3 : 'three';
          const [value, setValue] = React.useState(first);
          const [disabled, setDisabled] = React.useState(!!config.disabled);
          const ref = React.useRef(null);
          React.useEffect(() => { window.references[kind] = ref.current; }, []);
          return <section data-testid={kind} style={{marginBottom: 24}}>
            <Component ref={ref} options={[
              {value: first, label: <strong>Тест A</strong>, icon: <span aria-hidden="true">A</span>},
              {value: second, label: 'Тест B'},
              {value: third, label: 'Тест C', disabled: true},
            ]} {...(config.uncontrolled ? {defaultValue: first} : {value})}
              disabled={disabled} block size="small" aria-label="Тест: режим"
              className="probe-segmented"
              onChange={next => { window.changes[kind].push(next); setValue(next); }}/>
            <button onClick={() => setValue(value === first ? second : first)}>Тест: внешнее значение</button>
            <button onClick={() => setDisabled(!disabled)}>Тест: блокировка</button>
            <button onClick={() => ref.current.querySelector('input').focus()}>Тест: фокус</button>
          </section>;
        }
        createRoot(document.getElementById('root')).render(
          <ConfigProvider direction={config.rtl ? 'rtl' : 'ltr'}
            theme={{algorithm: config.dark ? theme.darkAlgorithm : theme.defaultAlgorithm}}>
            <Control kind="native" Component={Native}/>
            <Control kind="compat" Component={Segmented}/>
          </ConfigProvider>
        );
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles[0].text;
});

async function mount(page: Page, config: Record<string, boolean>) {
  await page.setContent('<main id="root" style="padding:16px"></main>');
  await page.evaluate(value => { window['probeConfig'] = value; }, config);
  await page.addScriptTag({ content: bundle });
  await expect(page.getByTestId('compat').getByRole('radio', { name: 'Тест A' })).toBeChecked();
  expect(await page.evaluate(() => window['sameComponent'])).toBe(true);
}

async function parity(page: Page) {
  // Wait for the native thumb animation before comparing DOM and layout.
  await expect(page.locator('.ant-segmented-thumb')).toHaveCount(0);
  const native = page.getByTestId('native').locator('.ant-segmented');
  const compat = page.getByTestId('compat').locator('.ant-segmented');
  expect(await compat.evaluate(element => element.outerHTML)).toBe(await native.evaluate(element => element.outerHTML));
  const boxes = await Promise.all([native.boundingBox(), compat.boundingBox()]);
  expect(boxes[1]!.width).toBe(boxes[0]!.width);
  expect(boxes[1]!.height).toBe(boxes[0]!.height);
  expect(await compat.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function clickDisabledLabel(page: Page, kind: string, name: string) {
  // Real pointer input: Playwright's actionability check deliberately refuses
  // locator.click on labels associated with disabled controls.
  const box = await page.getByTestId(kind).getByText(name, { exact: true }).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

for (const width of [320, 1280]) {
  for (const dark of [false, true]) {
    test.describe(`${width}px / ${dark ? 'dark' : 'light'}`, () => {
      test.use({ viewport: { width, height: 800 } });

      test('controlled string selection and external updates match native', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await mount(page, { dark });
        await parity(page);
        for (const kind of ['native', 'compat']) {
          const control = page.getByTestId(kind);
          // AntD 5.0 hides the radio at 0×0; users click its visible label.
          await control.locator('label').filter({ hasText: 'Тест B' }).click();
          await expect(control.getByRole('radio', { name: 'Тест B' })).toBeChecked();
          await control.getByRole('button', { name: 'Тест: внешнее значение' }).click();
          await expect(control.getByRole('radio', { name: 'Тест A' })).toBeChecked();
        }
        expect(await page.evaluate(() => window['changes'])).toEqual({ native: ['two'], compat: ['two'] });
        await parity(page);
        expect(errors).toEqual([]);
      });

      test('numeric values remain numbers, including RTL', async ({ page }) => {
        await mount(page, { dark, numeric: true, rtl: true });
        for (const kind of ['native', 'compat']) await page.getByTestId(kind).locator('label').filter({ hasText: 'Тест B' }).click();
        expect(await page.evaluate(() => window['changes'])).toEqual({ native: [2], compat: [2] });
        await parity(page);
      });

      test('disabled group and disabled option cannot trigger changes', async ({ page }) => {
        await mount(page, { dark, disabled: true });
        for (const kind of ['native', 'compat']) {
          const control = page.getByTestId(kind);
          await expect(control.getByRole('radio', { name: 'Тест B' })).toBeDisabled();
          await clickDisabledLabel(page, kind, 'Тест B');
          await expect(control.getByRole('radio', { name: 'Тест A' })).toBeChecked();
          await control.getByRole('button', { name: 'Тест: блокировка' }).click();
          await expect(control.getByRole('radio', { name: 'Тест B' })).toBeEnabled();
          await expect(control.getByRole('radio', { name: 'Тест C' })).toBeDisabled();
          await clickDisabledLabel(page, kind, 'Тест C');
        }
        expect(await page.evaluate(() => window['changes'])).toEqual({ native: [], compat: [] });
        await parity(page);
      });

      test('uncontrolled keyboard selection and forwarded DOM ref match native', async ({ page }) => {
        await mount(page, { dark, uncontrolled: true });
        for (const kind of ['native', 'compat']) {
          const control = page.getByTestId(kind);
          await control.getByRole('button', { name: 'Тест: фокус' }).click();
          await expect(control.getByRole('radio', { name: 'Тест A' })).toBeFocused();
          await control.getByRole('radio', { name: 'Тест B' }).focus();
          await page.keyboard.press('Space');
          await expect(control.getByRole('radio', { name: 'Тест B' })).toBeChecked();
          await control.getByRole('button', { name: 'Тест: внешнее значение' }).click();
          await expect(control.getByRole('radio', { name: 'Тест B' })).toBeChecked();
          expect(await page.evaluate(key => {
            const ref = window['references'][key];
            return ref === document.querySelector('[data-testid="' + key + '"] .ant-segmented') && ref.tagName === 'DIV';
          }, kind)).toBe(true);
        }
        expect(await page.evaluate(() => window['changes'])).toEqual({ native: ['two'], compat: ['two'] });
        await parity(page);
      });
    });
  }
}
