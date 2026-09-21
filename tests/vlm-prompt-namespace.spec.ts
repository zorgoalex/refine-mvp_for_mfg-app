import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';

let bundle: string;
const existing = {
  prompt_id: 42, namespace: 'legacy_custom', name: 'Тест промпт', notes: 'Описание',
  version: 3, lang: 'en', tags: ['keep', 'second'], priority: 7,
  is_default: true, is_active: false, prompt_id_deno: 'test-deno',
};

test.beforeAll(async () => {
  const result = await build({
    stdin: { loader: 'tsx', resolveDir: process.cwd(), contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { VlmPromptsSection } from './src/pages/configuration/components/VlmPromptsSection';
      createRoot(document.getElementById('root')).render(<VlmPromptsSection />);
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{"DEV":false}' },
    plugins: [{ name: 'mock-refine-boundary', setup(builder) {
      builder.onResolve({ filter: /^@refinedev\/core$/ }, () => ({ path: 'refine', namespace: 'test-refine' }));
      builder.onLoad({ filter: /.*/, namespace: 'test-refine' }, () => ({ loader: 'js', contents: `
        export const useList = () => ({ data: { data: [${JSON.stringify(existing)}] }, isLoading: false, refetch() {} });
        const mutation = kind => ({ isLoading: false, mutate(args, callbacks) {
          window.promptCalls.push({ kind, ...structuredClone(args) }); callbacks.onSuccess();
        }});
        export const useCreate = () => mutation('create');
        export const useUpdate = () => mutation('update');
        export const useDelete = () => mutation('delete');
      ` }));
    } }],
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.request().url() === 'http://vlm-prompts.test/'
    ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }) : route.abort());
  await page.goto('http://vlm-prompts.test/');
  await page.evaluate(() => { (window as any).promptCalls = []; });
  await page.addScriptTag({ content: bundle });
});

const calls = (page: Page) => page.evaluate(() => (window as any).promptCalls);

for (const namespace of ['order_details', 'test_custom_namespace']) {
  test(`create sends a single string namespace: ${namespace}`, async ({ page }) => {
    await page.getByRole('button', { name: /Добавить$/ }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Название', { exact: true }).fill('Тест новый промпт');
    const input = dialog.getByLabel('Namespace', { exact: true });
    await input.fill(namespace);
    if (namespace === 'order_details') {
      await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')).toHaveText([namespace]);
      await page.locator('.ant-select-item-option-content').getByText(namespace, { exact: true }).click();
    } else await input.press('Tab'); // Free text must save without selecting a tag.
    await dialog.getByRole('button', { name: 'Создать', exact: true }).click();
    await expect.poll(() => calls(page)).toEqual([{
      kind: 'create', resource: 'vlm_prompts', values: {
        namespace, name: 'Тест новый промпт', is_default: false, is_active: true,
        priority: 0, version: 1, lang: 'ru', tags: [], notes: undefined, prompt_id_deno: undefined,
      },
    }]);
    await expect(dialog).not.toBeVisible();
  });
}

test('edit preserves scalar namespace and all other values, then accepts replacement', async ({ page }) => {
  const edit = page.getByRole('row').filter({ hasText: existing.name }).getByRole('button').first();
  for (const namespace of [existing.namespace, 'replacement_namespace']) {
    await edit.click();
    const dialog = page.getByRole('dialog');
    const input = dialog.getByLabel('Namespace', { exact: true });
    await expect(input).toHaveValue(existing.namespace);
    if (namespace !== existing.namespace) await input.fill(namespace);
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  const { prompt_id, ...values } = existing;
  expect(await calls(page)).toEqual([existing.namespace, 'replacement_namespace'].map(namespace => ({
    kind: 'update', resource: 'vlm_prompts', id: prompt_id, meta: { idColumnName: 'prompt_id' },
    values: { ...values, namespace },
  })));
});

test('clear blocks save; cancel and reopen do not retain unsaved namespace', async ({ page }) => {
  const edit = page.getByRole('row').filter({ hasText: existing.name }).getByRole('button').first();
  await edit.click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('Namespace', { exact: true });
  const field = dialog.locator('.ant-form-item').filter({ has: page.locator('input#namespace') });
  await field.hover();
  await field.locator('.ant-select-clear').click();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByText('Введите namespace', { exact: true })).toBeVisible();
  expect(await calls(page)).toEqual([]);
  await input.fill('unsaved_namespace');
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await edit.click();
  await expect(input).toHaveValue(existing.namespace);
});
