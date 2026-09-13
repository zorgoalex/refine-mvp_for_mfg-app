import {expect,test} from '@playwright/test';
import type {MdfReturnPreview} from '../src/api/mdfProductionReturnApi';
test.setTimeout(90000);

const preview:MdfReturnPreview={source:{kind:'packet',id:'00000000-0000-0000-0000-000000000101',label:'Файл E2E'},
  targetColumn:'parsed',targetStage:{id:1,code:'drawn',name:'Отрисован',rank:10},stages:[{id:1,code:'drawn',name:'Отрисован',rank:10}],
  digest:'a'.repeat(64),details:Array.from({length:30},(_,i)=>({detailId:i+1,orderId:1,orderName:'E2E',detailNumber:i+1,quantity:10,
    cardQuantity:5,before:'Упакован',after:'Отрисован'})),orders:[{orderId:1,orderName:'E2E',before:'Выдан',after:'В производстве'}],
  cards:[{kind:'packet',id:'00000000-0000-0000-0000-000000000101',label:'Файл E2E',before:'completed_laminated',after:'parsed'}],
  resetsCompletion:true,warnings:['Повтор старой отметки выполнения не завершит файл снова.']};

test.beforeEach(async({page})=>{
  page.on('pageerror',error=>console.error(error.message));
  await page.route('**/e2e-mdf-return',route=>route.fulfill({contentType:'text/html',body:
    '<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><script type="module" src="/tests/fixtures/mdf-production-return-harness.tsx"></script></html>'}));
  await page.route('**/orders/status-board/mdf-return/**/preview',route=>route.fulfill({json:preview}));
});
test('real dialog shows consequences and cancels without sending confirm',async({page})=>{
  let mutations=0;
  await page.route('**/orders/status-board/mdf-return/**/confirm',route=>{mutations++;return route.fulfill({json:{preview}});});
  await page.goto('/e2e-mdf-return');
  await expect(page.getByText('Статус заказа тоже изменится')).toBeVisible({timeout:60000});
  await expect(page.getByText('E2E: Выдан → В производстве')).toBeVisible();
  await expect(page.locator('textarea')).toHaveCount(0);
  await page.getByRole('button',{name:'Отмена',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('Отменено');
  expect(mutations).toBe(0);
});
test('phone layout keeps confirmation reachable and sends one source-scoped command',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const commands:Record<string,unknown>[]=[];
  await page.route('**/orders/status-board/mdf-return/**/confirm',route=>{
    commands.push(route.request().postDataJSON());return route.fulfill({json:{preview,auditId:'E2E',requestId:'E2E'}});
  });
  await page.goto('/e2e-mdf-return');
  const confirm=page.getByRole('button',{name:'Подтвердить возврат'});
  await expect(confirm).toBeEnabled({timeout:60000});
  await page.getByText('Детали (30)',{exact:true}).click();
  const box=await confirm.boundingBox();
  expect(box).not.toBeNull();expect(box!.y+box!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await confirm.click();
  await expect(page.getByRole('status')).toHaveText('Возврат выполнен');
  expect(commands).toHaveLength(1);expect(commands[0]).toMatchObject({targetColumn:'parsed',productionStatusId:1,expectedDigest:preview.digest});
  expect(commands[0]).not.toHaveProperty('reason');expect(commands[0]).not.toHaveProperty('detailIds');
});
