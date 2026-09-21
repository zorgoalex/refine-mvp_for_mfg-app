import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run only under rtk-heavy-guard. Own server/browser state; never attaches to another agent's browser.
const directory = await mkdtemp(path.join(os.tmpdir(),'erp-inbound-browse-'));
const browser = await chromium.launch({ headless:true });
const page = await browser.newPage({ viewport:{ width:1440,height:1000 } });
page.setDefaultTimeout(30000);
const errors=[];
page.on('pageerror',error=>{ errors.push(error.message); console.error('Fixture page error:',error.message); });
const browse = async (command,value) => {
  console.log(command,value ?? '');
  if (command==='goto') return page.goto(value);
  if (command==='wait') return page.locator(value).first().waitFor({ state:'visible' });
  if (command==='text') return page.locator('body').innerText();
  if (command==='click') return page.locator(value).first().click();
  if (command==='screenshot') return page.screenshot({ path:value,fullPage:true });
  if (command==='viewport') { const [width,height]=value.split('x').map(Number); return page.setViewportSize({ width,height }); }
  if (command==='console') return errors.join('\n');
  throw new Error(`Unsupported fixture command: ${command}`);
};
const server = await createServer({ configFile:false,root:process.cwd(),cacheDir:path.join(directory,'vite-cache'),server:{ host:'127.0.0.1',port:5194,strictPort:true },
  resolve:{ alias:{ '@shared':path.resolve('backend/src/shared') } },optimizeDeps:{ entries:['tests/fixtures/inbound-signals.tsx'] },
  plugins:[{ name:'inbound-fixture',configureServer(server) { server.middlewares.use((req,res,next) => {
    if (!req.url?.startsWith('/fixture')) return next();
    res.setHeader('Content-Type','text/html'); res.end('<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tests/fixtures/inbound-signals.tsx"></script></body></html>');
  }); } }] });
try {
  await server.listen();
  await browse('goto','http://127.0.0.1:5194/fixture');
  await browse('wait','.ant-table-row');
  let text=await browse('text'); assert.match(text,/Входящие сигналы/); assert.match(text,/Заказ 1254 готов/); assert.match(text,/действия приостановлены/);
  await browse('click','text=Подробнее'); await browse('wait','.ant-drawer-body .ant-timeline');
  text=await browse('text'); assert.match(text,/Найдены ключевые слова/); assert.match(text,/Уточнить заказ/);
  await browse('click','input[aria-label="Заказ для сигнала"]');
  await browse('click','text=E2E-Тест заказ · ID 1254');
  await browse('click','text=Проверить действия'); await browse('wait','text=Сработают правила: Готов к выдаче');
  await browse('click','text=Привязать и обработать'); await browse('wait','.ant-modal-confirm');
  await browse('click','.ant-modal-confirm .ant-btn-primary'); await browse('wait','text=Ожидает обработки');
  await page.locator('.ant-modal-confirm').waitFor({ state:'hidden' });
  await browse('screenshot',path.join(directory,'signal.png'));
  await browse('goto','http://127.0.0.1:5194/fixture?manager'); await browse('wait','.ant-table-row');
  text=await browse('text'); assert.doesNotMatch(text,/Технический вид|Включая сообщения без совпадений/);
  await browse('click','text=E2E-Тест ошибка сети'); await browse('click','text=Обновить'); await browse('wait','text=Не удалось обновить журнал');
  await browse('goto','http://127.0.0.1:5194/fixture?config'); await browse('wait','input[value="shop"]');
  await browse('click','text=Сохранить настройки'); await browse('wait','text=Настройки сохранены');
  await browse('click','text=Ключевые слова'); await browse('wait','input[value="ready"]:visible');
  await browse('screenshot',path.join(directory,'configuration.png'));
  await browse('viewport','390x844'); await browse('screenshot',path.join(directory,'mobile.png'));
  const errors=await browse('console','--errors');
  assert.doesNotMatch(errors,/TypeError|ReferenceError|Unhandled|Uncaught/);
  console.log(`INBOUND BROWSER PASS; screenshots: ${directory}`);
} finally {
  try { await browser.close(); } finally { await server.close(); }
}
