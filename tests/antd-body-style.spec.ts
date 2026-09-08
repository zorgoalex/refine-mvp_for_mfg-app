import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { bodyStyleCases, readBodyStyleProps } from './helpers/antdBodyStyleCases';

let bundle: string;
test.beforeAll(async () => {
  const cases = bodyStyleCases.map((entry) => ({ ...entry, props: readBodyStyleProps(entry.file, entry.tag) }));
  const result = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'tsx',
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Modal, Drawer } from 'antd';
        import { ImagePrintPreviewModal } from './src/components/ImagePrintPreviewModal';
        import { ResizableModalWrapper } from './src/components/ResizableModalWrapper';
        const cases = ${JSON.stringify(cases)};
        function App() {
          const [open, setOpen] = React.useState(true);
          const entry = cases[window.testCase];
          const close = () => setOpen(false);
          const content = <div style={{flex: 1, overflow: 'auto', minHeight: 0}} data-testid="content-scroll">
            <div style={{height: 1200}}>Тест: длинное содержимое</div>
            <button>Тест: последняя строка</button>
          </div>;
          return <><button onClick={() => setOpen(true)}>Тест: открыть</button>{
            entry.name === 'image preview'
              ? <ImagePrintPreviewModal open={open} onClose={close} imageUrl={null} title="Тест: изображение" alt="Тест" printTitle="Тест" emptyContent={<p>Тест: нет изображения</p>} />
              : entry.tag === 'Drawer'
                ? <Drawer {...entry.props} open={open} onClose={close} title="Тест: меню" width={280} placement="left">{content}</Drawer>
                : <Modal {...entry.props} open={open} onCancel={close} title="Тест: окно" width={1200} style={{top: 20}}
                    footer={<button onClick={close}>Тест: закрыть</button>}
                    modalRender={entry.name === 'photo import' ? node => <ResizableModalWrapper open={open} minHeight={400} defaultHeight={550}>{node}</ResizableModalWrapper> : undefined}
                  >{content}</Modal>
          }</>;
        }
        createRoot(document.getElementById('root')).render(<App />);
      `,
    },
    bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles[0].text;
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 720 }]) {
  test.describe(`${viewport.width}px viewport`, () => {
    test.use({ viewport });
    for (const [index, entry] of bodyStyleCases.entries()) {
      test(`${entry.name}: body CSS, reachable controls, close/reopen`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setContent('<div id="root"></div>');
        await page.evaluate(value => { Object.assign(window, { testCase: value }); }, index);
        await page.addScriptTag({ content: bundle });
        const body = page.locator(entry.tag === 'Drawer' ? '.ant-drawer-body' : '.ant-modal-body');
        await expect(body).toBeVisible();
        const css = await body.evaluate((element, expected) => {
          const reference = document.createElement('div').style;
          return Object.entries(expected).map(([property, value]) => {
            const kebab = property.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase());
            reference.setProperty(kebab, typeof value === 'number' ? value + 'px' : value);
            return { property, actual: element.style.getPropertyValue(kebab), expected: reference.getPropertyValue(kebab) };
          });
        }, entry.expected);
        for (const property of css) {
          expect(property.expected, 'valid CSS').not.toBe('');
          expect(property.actual, property.property).toBe(property.expected);
        }
        if (entry.name === 'label editor') {
          const dimensions = await body.evaluate(element => {
            element.scrollTop = element.scrollHeight;
            return { height: element.clientHeight, scrollTop: element.scrollTop };
          });
          expect(dimensions.height).toBeLessThanOrEqual(viewport.height * 0.72 + 1);
          expect(dimensions.scrollTop).toBeGreaterThan(0);
        }
        if (entry.name !== 'image preview') {
          await page.getByRole('button', { name: 'Тест: последняя строка' }).scrollIntoViewIfNeeded();
          await expect(page.getByRole('button', { name: 'Тест: последняя строка' })).toBeInViewport();
        }
        const close = entry.name === 'image preview'
          ? page.getByRole('button', { name: 'Закрыть просмотр' })
          : entry.tag === 'Drawer' ? page.getByRole('button', { name: 'Close', exact: true })
          : page.getByRole('button', { name: 'Тест: закрыть', exact: true });
        await close.click();
        await expect(body).not.toBeVisible();
        await page.getByRole('button', { name: 'Тест: открыть' }).click();
        await expect(body).toBeVisible();
        expect(errors).toEqual([]);
      });
    }
  });
}
