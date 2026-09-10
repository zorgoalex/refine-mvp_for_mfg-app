// Isolated visual regression: real React component + production CSS; no API/data writes.
// Run under rtk-heavy-guard; one Chromium instance, closed in finally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const bundle = await build({ entryPoints: ['src/components/OrderProductionSummary.tsx'],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
  loader: { '.css': 'empty' } });
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { OrderProductionSummary } = module.exports;
const summary = (name, total, missing, distinct) => ({ productionStatusName: name,
  productionDetailCount: total, productionUnassignedCount: missing, productionDistinctStatusCount: distinct });
const cases = [
  ['mixed', summary('Распилен', 10, 0, 3)],
  ['uniform', summary('Распилен', 10, 0, 1)],
  ['missing', summary(null, 10, 2, 2)],
  ['all-missing', summary(null, 10, 10, 0)],
  ['empty', summary(null, 0, 0, 0)],
  ['long', summary('Очень длинный производственный этап', 10, 0, 2)],
];
const component = order => renderToStaticMarkup(React.createElement(OrderProductionSummary, { order }));
const css = readFileSync('src/components/orderProductionSummary.css', 'utf8');
const appCss = readFileSync('src/styles/app.css', 'utf8');
const cardCss = readFileSync('src/pages/orderStatusBoard/orderStatusBoard.css', 'utf8');
const html = `<html lang="ru"><head><style>${appCss}\n${cardCss}\n${css}
body{margin:0;padding:24px;font-family:Arial,sans-serif} .example{display:flex;gap:16px;align-items:center;margin:12px 0}
.caption{width:140px;font-size:13px} .slot{width:90px} .stage-card{width:220px;padding:10px;border:1px solid #ccc}
</style></head><body>${cases.map(([id, order]) => `<div class="example"><span class="caption">${id}</span><div class="slot" id="${id}">${component(order)}</div></div>`).join('')}
<div class="status-board-page--cnc"><div class="status-board-columns--cnc"><div class="stage-card status-board-card cnc-order-card"><div class="status-board-card__identity"><span>12345</span><span>В производстве</span>${component(cases[0][1])}</div></div></div></div>
</body></html>`;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 540, height: 400 }, deviceScaleFactor: 2 });
  await page.setContent(html);
  const state = await page.locator('#mixed .order-production-summary').evaluate(el => {
    const text = el.firstElementChild;
    const box = el.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(text);
    const glyphs = range.getBoundingClientRect();
    return { label: el.textContent, background: getComputedStyle(el).backgroundImage,
      textBackground: getComputedStyle(text).backgroundImage,
      clipped: getComputedStyle(text).backgroundClip, width: box.width, height: box.height,
      seamInsideWord: glyphs.left < box.left + box.width / 2 && glyphs.right > box.left + box.width / 2 };
  });
  assert.equal(state.label, 'Распилен');
  assert.match(state.background, /rgb\(254, 215, 170\) 50%, rgb\(186, 230, 253\) 50%/);
  assert.match(state.textBackground, /rgb\(124, 45, 18\) 50%, rgb\(12, 74, 110\) 50%/);
  assert.equal(state.clipped, 'text');
  assert.equal(state.seamInsideWord, true);
  assert.ok(state.width <= 90 && state.height <= 20);
  assert.equal(await page.locator('#uniform .order-production-summary').getAttribute('data-mixed'), 'false');
  assert.equal(await page.locator('#missing .order-production-summary').innerText(), 'Без статуса');
  assert.match(await page.locator('#missing .order-production-summary').getAttribute('title'), /2 из 10/);
  assert.equal(await page.locator('#all-missing .order-production-summary').getAttribute('data-mixed'), 'false');
  assert.ok(await page.locator('#long .order-production-summary').evaluate(el => el.getBoundingClientRect().width <= 90));
  const luminance = rgb => rgb.map(x => x / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)
    .reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
  const contrasts = [[[254, 215, 170], [124, 45, 18]], [[186, 230, 253], [12, 74, 110]]]
    .map(([bg, fg]) => (luminance(bg) + 0.05) / (luminance(fg) + 0.05));
  assert.ok(contrasts.every(ratio => ratio >= 4.5));
  if (process.env.BADGE_SCREENSHOT_PATH) await page.screenshot({ path: process.env.BADGE_SCREENSHOT_PATH });
  await page.locator('html').evaluate(el => el.setAttribute('data-theme', 'dark'));
  assert.equal(await page.locator('#uniform .order-production-summary').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(38, 38, 38)');
  assert.equal(await page.locator('#uniform .order-production-summary').evaluate(el => getComputedStyle(el).color), 'rgb(240, 240, 240)');
  await page.emulateMedia({ forcedColors: 'active' });
  const forced = await page.locator('#mixed .order-production-summary__text').evaluate(el => ({
    color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundImage,
    marker: getComputedStyle(el, '::after').content,
  }));
  assert.notEqual(forced.color, 'rgba(0, 0, 0, 0)');
  assert.equal(forced.background, 'none');
  assert.match(forced.marker, /≠/);
  console.log(JSON.stringify({ result: 'PASS', state, contrasts, forced }));
} finally {
  await browser.close();
}
