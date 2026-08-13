import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const boardCss = readFileSync(
  'src/pages/orderStatusBoard/orderStatusBoard.css',
  'utf8',
);

const screenshotUrl = `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="400" height="1200" viewBox="0 0 400 1200">
    <rect width="400" height="1200" fill="white" stroke="black" />
  </svg>
`)}`;

test('fits detailed machine SVG maps and screenshot fallback to viewport height', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.setContent(`
    <style>${boardCss}</style>
    <section class="cnc-detailed-workspace__machine" style="width: 700px">
      <article class="cnc-detailed-machine-map">
        <figure class="cnc-detailed-machine-map__figure">
          <div class="cnc-bath-card__sheet-svg cnc-detailed-machine-map__svg" data-testid="portrait-map">
            <svg width="400" height="1200" viewBox="0 0 400 1200">
              <rect width="400" height="1200" fill="white" stroke="black" />
            </svg>
          </div>
        </figure>
        <figure class="cnc-detailed-machine-map__figure">
          <div class="cnc-bath-card__sheet-svg cnc-detailed-machine-map__svg" data-testid="landscape-map">
            <svg width="1200" height="400" viewBox="0 0 1200 400">
              <rect width="1200" height="400" fill="white" stroke="black" />
            </svg>
          </div>
        </figure>
        <img
          class="cnc-detailed-machine-map__screenshot"
          data-testid="screenshot"
          src="${screenshotUrl}"
          alt="fixture"
        />
      </article>
    </section>
  `);
  await page.getByTestId('screenshot').evaluate((image: HTMLImageElement) => image.decode());

  const readGeometry = () => page.evaluate(() => {
    const machine = document.querySelector<HTMLElement>('.cnc-detailed-workspace__machine')!;
    const portrait = document.querySelector<HTMLElement>('[data-testid="portrait-map"] svg')!;
    const landscape = document.querySelector<HTMLElement>('[data-testid="landscape-map"] svg')!;
    const screenshot = document.querySelector<HTMLElement>('[data-testid="screenshot"]')!;
    const rect = (element: HTMLElement) => {
      const bounds = element.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    };
    return {
      maxHeight: getComputedStyle(machine)
        .getPropertyValue('--cnc-detailed-machine-preview-max-height')
        .trim(),
      portrait: rect(portrait),
      landscape: rect(landscape),
      screenshot: rect(screenshot),
    };
  });

  const regularViewport = await readGeometry();
  expect(regularViewport.maxHeight).toBe('clamp(220px, calc(100dvh - 280px), 720px)');
  expect(regularViewport.portrait.height).toBeLessThanOrEqual(520);
  expect(regularViewport.landscape.height).toBeLessThanOrEqual(520);
  expect(regularViewport.screenshot.height).toBeLessThanOrEqual(520);
  expect(regularViewport.portrait.width / regularViewport.portrait.height).toBeCloseTo(1 / 3, 2);
  expect(regularViewport.landscape.width / regularViewport.landscape.height).toBeCloseTo(3, 2);
  expect(regularViewport.screenshot.width / regularViewport.screenshot.height).toBeCloseTo(1 / 3, 2);

  await page.setViewportSize({ width: 1440, height: 500 });
  const shortViewport = await readGeometry();
  expect(shortViewport.portrait.height).toBeLessThanOrEqual(220);
  expect(shortViewport.screenshot.height).toBeLessThanOrEqual(220);

  await page.setViewportSize({ width: 1440, height: 1200 });
  const tallViewport = await readGeometry();
  expect(tallViewport.portrait.height).toBeLessThanOrEqual(720);
  expect(tallViewport.screenshot.height).toBeLessThanOrEqual(720);
});

test('keeps MDF phone columns 15 percent denser than desktop runtime grid', async ({ page }) => {
  await page.setViewportSize({ width: 408, height: 816 });
  await page.setContent(`
    <style>${boardCss}</style>
    <section class="status-board-page status-board-page--cnc">
      <section class="status-board-viewport" style="width: 408px; height: 640px;">
        <div
          class="status-board-columns status-board-columns--cnc status-board-columns--cnc-standard"
          style="--status-board-cnc-column-count: 5; grid-template-columns: repeat(5, minmax(var(--status-board-cnc-column-width, 220px), 1fr)); min-width: 1148px;"
        >
          ${Array.from({ length: 5 }, (_, index) => `
            <article class="status-board-column" data-testid="mdf-column-${index}">
              <header class="status-board-column__header"></header>
              <div class="status-board-column__cards"></div>
            </article>
          `).join('')}
        </div>
      </section>
    </section>
  `);

  const geometry = await page.evaluate(() => {
    const columns = Array.from(document.querySelectorAll<HTMLElement>('.status-board-column'));
    const grid = document.querySelector<HTMLElement>('.status-board-columns--cnc')!;
    const firstColumn = columns[0]!;
    return {
      columnCount: columns.length,
      columnWidth: Math.round(firstColumn.getBoundingClientRect().width),
      cssColumnWidth: getComputedStyle(grid).getPropertyValue('--status-board-cnc-column-width').trim(),
      gridTemplateColumns: getComputedStyle(grid).gridTemplateColumns,
      viewportScrollWidth: grid.parentElement?.scrollWidth ?? 0,
    };
  });

  expect(geometry.columnCount).toBe(5);
  expect(geometry.cssColumnWidth).toBe('187px');
  expect(geometry.columnWidth).toBe(187);
  expect(geometry.gridTemplateColumns).not.toContain('220px');
  expect(geometry.viewportScrollWidth).toBeGreaterThan(408);
});
