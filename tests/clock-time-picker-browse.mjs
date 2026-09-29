import { createServer } from 'vite';
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ClockTimePicker in real antd Form under React.StrictMode. Fixture-only HTTP; never touches ERP/WhatsApp.
const PORT = 5197;
const directory = await mkdtemp(path.join(os.tmpdir(), 'erp-clock-picker-'));
const browser = await chromium.launch({ headless: true });
const errors = [];
const server = await createServer({ configFile: false, root: process.cwd(), cacheDir: path.join(directory, 'vite-cache'),
  server: { host: '127.0.0.1', port: PORT, strictPort: true },
  optimizeDeps: { entries: ['tests/fixtures/clock-time-picker.tsx'] },
  plugins: [{ name: 'clock-fixture', configureServer(s) { s.middlewares.use((req, res, next) => {
    if (req.url !== '/fixture') return next();
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/clock-time-picker.tsx"></script></body></html>');
  }); } }],
});
const URL = `http://127.0.0.1:${PORT}/fixture`;
const dial = (page) => page.locator('svg[role=group]');
// point in the 240x240 dial viewBox -> page coordinates
async function at(page, x, y) {
  // wait until the open animation has settled and the box stops moving
  let box = await dial(page).boundingBox();
  for (let i = 0; i < 30; i += 1) {
    await page.waitForTimeout(60);
    const next = await dial(page).boundingBox();
    const stable = box && next && Math.abs(next.x - box.x) < 0.5 && Math.abs(next.y - box.y) < 0.5 && Math.abs(next.width - box.width) < 0.5;
    box = next;
    if (stable) break;
  }
  assert.ok(box, 'dial is visible');
  return { x: box.x + (x * box.width) / 240, y: box.y + (y * box.height) / 240 };
}
const polar = (deg, r) => ({ x: 120 + r * Math.sin((deg * Math.PI) / 180), y: 120 - r * Math.cos((deg * Math.PI) / 180) });
async function fresh(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL);
  await expect(page.locator('#sendTime')).toBeVisible();
  return page;
}
async function submit(page, expectedCount) {
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByTestId('submits')).toHaveText(String(expectedCount));
  return JSON.parse(await page.getByTestId('last-submit').innerText());
}

try {
  await server.listen();
  const desktop = await browser.newContext({ viewport: { width: 900, height: 900 } });

  // 1. mouse click: hour 3 (outer), then minute 45 -> value shown and submitted exactly once
  let page = await fresh(desktop);
  await page.locator('#sendTime').click();
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор часов');
  let p = polar(90, 96); p = await at(page, p.x, p.y); await page.mouse.click(p.x, p.y);
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор минут');
  p = polar(270, 96); p = await at(page, p.x, p.y); await page.mouse.click(p.x, p.y);
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#sendTime')).toHaveValue(/^03:45$/);
  let sent = await submit(page, 1);
  assert.equal(sent.sendTime, '03:45');
  assert.equal(await page.evaluate(() => document.activeElement?.id !== undefined), true);
  console.log('ok mouse click + submit');

  // 2. mouse drag on the dial (inner ring hour 15, then minute 30 by dragging from 15)
  await page.locator('#catchUp').click();
  p = polar(0, 96); p = await at(page, p.x, p.y);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  let q = polar(90, 62); q = await at(page, q.x, q.y);
  await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up();
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор минут');
  p = polar(90, 96); p = await at(page, p.x, p.y);
  await page.mouse.move(p.x, p.y); await page.mouse.down();
  q = polar(180, 96); q = await at(page, q.x, q.y);
  await page.mouse.move(q.x, q.y, { steps: 6 }); await page.mouse.up();
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#catchUp')).toHaveValue(/^15:30$/);
  sent = await submit(page, 2);
  assert.deepEqual(sent, { sendTime: '03:45', catchUp: '15:30' });
  console.log('ok mouse drag');
  await page.close();

  // 3. touch tap
  const touch = await browser.newContext({ viewport: { width: 500, height: 800 }, hasTouch: true });
  page = await fresh(touch);
  await page.locator('#sendTime').tap();
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор часов');
  p = polar(180, 96); p = await at(page, p.x, p.y); await page.touchscreen.tap(p.x, p.y);
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор минут');
  p = polar(120, 96); p = await at(page, p.x, p.y); await page.touchscreen.tap(p.x, p.y);
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#sendTime')).toHaveValue(/^06:20$/);
  console.log('ok touch tap');
  await touch.close();

  // 4. typed 930 + blur onto the dial, then hour 10 -> 10:30
  page = await fresh(desktop);
  await page.locator('#sendTime').click();
  await expect(dial(page)).toBeVisible();
  await page.locator('#sendTime').fill('930');
  p = polar(300, 96); p = await at(page, p.x, p.y); await page.mouse.click(p.x, p.y);
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор минут');
  await page.keyboard.press('Escape');
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#sendTime')).toHaveValue('10:30');
  sent = await submit(page, 1);
  assert.equal(sent.sendTime, '10:30');
  // invalid text reverts
  await page.locator('#sendTime').fill('99:99'); await page.locator('#sendTime').blur();
  await expect(page.locator('#sendTime')).toHaveValue('10:30');
  console.log('ok typed + dial base');
  await page.close();

  // 5. keyboard only: ArrowDown opens, arrows + Enter (hours), arrows + Enter (minutes), focus back on input
  page = await fresh(desktop);
  await page.locator('#sendTime').focus();
  await page.keyboard.press('ArrowDown');
  await expect(dial(page)).toBeVisible();
  await expect(dial(page)).toBeFocused();
  const header = await page.locator('button[aria-pressed]').allInnerTexts();
  const h0 = Number(header[0]); const m0 = Number(header[1]);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор минут');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(dial(page)).toHaveCount(0);
  const pad = (n) => String(n).padStart(2, '0');
  await expect(page.locator('#sendTime')).toHaveValue(`${pad((h0 + 2) % 24)}:${pad((m0 + 5) % 60)}`);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sendTime');
  // Escape returns focus to the input
  await page.keyboard.press('ArrowDown');
  await expect(dial(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dial(page)).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sendTime');
  // Tab inside the panel keeps the value
  const before = await page.locator('#sendTime').inputValue();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#sendTime').inputValue(), before);
  console.log('ok keyboard');
  await page.close();

  // 7. mouse open must not steal focus: real typing, Enter never submits the form, aria from Form.Item
  page = await fresh(desktop);
  await page.locator('#sendTime').click();
  await expect(dial(page)).toBeVisible();
  await page.keyboard.type('930');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sendTime');
  await page.locator('#sendTime').blur();
  await expect(page.locator('#sendTime')).toHaveValue('09:30');
  await page.locator('#sendTime').focus();
  await page.keyboard.press('Escape');
  await expect(dial(page)).toHaveCount(0);
  await page.locator('#sendTime').fill('1015');
  await page.keyboard.press('Enter');
  await expect(page.locator('#sendTime')).toHaveValue('10:15');
  await page.waitForTimeout(300);
  await expect(page.getByTestId('submits')).toHaveText('0');
  await page.keyboard.press('Enter');            // unchanged text: opens the dial from the keyboard
  await expect(dial(page)).toBeFocused();
  await page.keyboard.press('Enter');            // commits hour on the dial
  await expect(dial(page)).toHaveAttribute('aria-label', 'Выбор минут');
  await page.keyboard.press('Enter');            // commits minutes, closes
  await expect(dial(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(page.getByTestId('submits')).toHaveText('0');
  console.log('ok enter does not submit + mouse open keeps focus');
  await page.close();

  page = await fresh(desktop);
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('#sendTime')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#sendTime')).toHaveAttribute('aria-required', 'true');
  const describedBy = await page.locator('#sendTime').getAttribute('aria-describedby');
  assert.ok(describedBy, 'aria-describedby is forwarded');
  assert.match(await page.locator(`[id="${describedBy}"]`).innerText(), /Укажите время/);
  console.log('ok aria props');
  await page.close();

  // 8. Tab / Shift+Tab leave the field natively (page order: #before -> #sendTime -> #catchUp), value kept, panel closed
  page = await fresh(desktop);
  await page.locator('#sendTime').click();
  await expect(dial(page)).toBeVisible();
  await page.keyboard.type('1145');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'before');
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#sendTime')).toHaveValue('11:45');
  await page.locator('#sendTime').click();
  await expect(dial(page)).toBeVisible();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('1200');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'catchUp');
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#sendTime')).toHaveValue('12:00');
  console.log('ok tab / shift+tab');
  await page.close();

  // 6. disabled Form: typing and opening are impossible
  page = await fresh(desktop);
  await page.getByRole('button', { name: 'Отключить форму', exact: true }).click();
  await expect(page.locator('#sendTime')).toBeDisabled();
  await expect(page.locator('#catchUp')).toBeDisabled();
  await page.locator('#sendTime').click({ force: true });
  await expect(dial(page)).toHaveCount(0);
  await page.locator('.ant-input-affix-wrapper').first().click({ force: true });
  await expect(dial(page)).toHaveCount(0);
  await expect(page.locator('#sendTime')).toHaveValue('');
  // open dial, then disable the form: the panel closes
  await page.getByRole('button', { name: 'Включить форму', exact: true }).click();
  await page.locator('#sendTime').click();
  await expect(dial(page)).toBeVisible();
  // the open panel overlaps the toggle: dispatch the click instead of a pointer click
  await page.getByRole('button', { name: 'Отключить форму', exact: true }).dispatchEvent('click');
  await expect(page.locator('#sendTime')).toBeDisabled();
  await expect(dial(page)).toHaveCount(0);
  console.log('ok disabled form');
  await page.close();

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(`CLOCK TIME PICKER BROWSER PASS: ${directory}`);
} finally { await browser.close(); await server.close(); }
