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
