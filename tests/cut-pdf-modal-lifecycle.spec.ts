import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import ts from 'typescript';
import { expect, test } from '@playwright/test';

let bundle: string;
test.beforeAll(async () => {
  // Exercise the exact production Modal JSX against installed AntD. Only its
  // PDF child is a stateful probe; actual PDF cleanup has CutPdfPreview tests.
  const source = ts.createSourceFile('CutPage.tsx', readFileSync('src/pages/cut/CutPage.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'Modal'
      && node.openingElement.attributes.getText(source).includes('onCancel={closeGroupPdfPreview}')) matches.push(node.getText(source));
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(matches).toHaveLength(1);
  const result = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState, useEffect } from 'react';
      import { createRoot } from 'react-dom/client';
      import { Modal, Button } from 'antd';
      import { PrinterOutlined } from '@ant-design/icons';
      window.pdfUnmounts = 0;
      function CutPdfPreview() {
        const [zoom, setZoom] = useState(100);
        useEffect(() => () => { window.pdfUnmounts++; }, []);
        return <button data-testid="zoom" onClick={() => setZoom(125)}>{zoom}</button>;
      }
      function App() {
        const [pdfPreview, setPreview] = useState({ title: 'Тест PDF', open: false, blob: null, loading: false });
        const closeGroupPdfPreview = () => setPreview(value => ({ ...value, open: false, blob: null }));
        const downloadPreviewPdf = () => {};
        const printPreviewPdf = () => {};
        return <><button onClick={() => setPreview(value => ({ ...value, open: true }))}>Открыть</button>${matches[0]}</>;
      }
      createRoot(document.getElementById('root')).render(<App />);
    ` },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles[0].text;
});

for (const closeBy of ['footer', 'escape'] as const) {
  test(`PDF modal unmounts after ${closeBy} close and reopens with fresh state`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle });
    await page.getByRole('button', { name: 'Открыть', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Скачать', exact: true })).toBeDisabled();
    await expect(dialog.getByTestId('print-preview-pdf-btn')).toBeDisabled();
    await page.getByTestId('zoom').click();
    await expect(page.getByTestId('zoom')).toHaveText('125');
    if (closeBy === 'footer') await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
    else await page.keyboard.press('Escape');
    await expect(page.getByTestId('zoom')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).pdfUnmounts)).toBe(1);
    await page.getByRole('button', { name: 'Открыть', exact: true }).click();
    await expect(page.getByTestId('zoom')).toHaveText('100');
    expect(errors).toEqual([]);
  });
}
