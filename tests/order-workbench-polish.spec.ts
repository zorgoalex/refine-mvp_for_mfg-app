import { expect, test, type Page } from '@playwright/test';
import { createWorkflowMockDb, setupWorkflowMockApi, type WorkflowMockDb } from './helpers/mockWorkflowApi';

// Presentation-only polish of the «NewLine» variant: the orders list and the order card
// must keep every column, action and section of the other variants.
const shotsDir = process.env.WORKBENCH_SHOTS_DIR;
if (process.env.PLAYWRIGHT_BASE_URL) test.use({ baseURL: process.env.PLAYWRIGHT_BASE_URL });
test.use({ viewport: { width: 1440, height: 900 } });

const ORIGINAL_SECTIONS = ['Группы заказа', 'Дедлайны', 'Финансы', 'Раскрой', 'Дополнительная информация'];

test.describe('Workbench orders polish', () => {
    test.setTimeout(180000);

    test('orders list keeps its columns and actions and shows statuses in full', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench');

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('html')).toHaveAttribute('data-ui-variant', 'workbench');
        const table = page.locator('.orders-table');
        await expect(table.locator('tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });

        for (const title of ['Заказ', 'Дата заказа', 'Клиент', 'Материал', 'Статус заказа', 'Статус оплаты', 'Этапы', 'Действия']) {
            await expect(table.locator('thead th', { hasText: title }).first()).toBeAttached();
        }
        for (const name of ['Найти', 'Фильтры', 'Создать заказ']) {
            await expect(page.getByRole('button', { name }).first()).toBeVisible();
        }
        await expect(page.getByText('Мои заказы')).toBeVisible();

        // статусы — пилюли с полным текстом, срок — с подсказкой
        const row = table.locator('tr[data-row-key="15"]');
        const pay = row.locator('td.payment-status .wb-pill');
        await pay.scrollIntoViewIfNeeded();
        await expect(pay).toHaveText('Частично оплачен');
        await expect(pay).toHaveAttribute('data-tone', 'warning');
        expect(await pay.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
        await expect(row.locator('td.order-status .wb-pill')).toHaveText('В производстве');
        await expect(row.locator('td.orders-col--planned-date .wb-deadline small')).toHaveText(/через \d+ дн\.|сегодня|завтра|просрочено/);
        expect(await row.locator('td.orders-col--order-date').evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');
        await page.locator('.orders-table .ant-table-body, .orders-table .ant-table-content').first().evaluate((element) => { element.scrollLeft = 0; });

        // «Базис-проект» — той же ширины, что «Дата заказа», значение в одну строку
        // (сравниваем заданную ширину колонок: в мок-таблице их мало, и браузер растягивает сортируемые)
        const widths = await table.evaluate((element) => {
            const heads = [...element.querySelectorAll('thead th')];
            const cols = [...element.querySelectorAll('colgroup')].pop()?.querySelectorAll('col') ?? [];
            const width = (title: string) => {
                const index = heads.findIndex((cell) => cell.textContent?.trim() === title);
                return index >= 0 ? (cols[index] as HTMLElement | undefined)?.style.width ?? null : null;
            };
            return { basis: width('Базис-проект'), date: width('Дата заказа') };
        });
        expect(widths.basis).toBe('90px');
        expect(widths.basis).toBe(widths.date);
        expect(await row.locator('td.orders-col--basis-project').evaluate((element) => getComputedStyle(element).whiteSpace)).toBe('nowrap');

        await shot(page, 'orders-list');
        expect(pageErrors).toEqual([]);
    });

    test('orders list: NewLine keeps its own column layout and draws it at once after a reload', async ({ page }) => {
        await openWithVariant(page, 'workbench');
        const hiddenInOldUi = ['order_status_name', 'payment_status_name', 'final_amount', 'production_status_name', 'planned_completion_date',
            'bazis_cut_numbers', 'cut_numbers', 'bath_cut_numbers', 'groups', 'priority', 'paid_amount', 'total_amount', 'discount', 'surcharge',
            'design_engineer', 'payment_date', 'issue_date', 'total_area', 'completion_date', 'parts_count', 'edge_type_name', 'created_by'];
        let saved: Record<string, { order: string[]; hidden: string[] }> = {
            // расклад, сохранённый в прежнем интерфейсе: статусы и суммы скрыты
            orderList: { order: ['order_name', 'doweling_order_name', 'order_date', 'client_name'], hidden: hiddenInOldUi },
        };
        await page.route(/\/api\/v1\/me\/preferences$/, async (route) => {
            if (route.request().method() === 'PATCH') {
                const body = JSON.parse(route.request().postData() || '{}');
                if (body.orderDetailColumns) saved = body.orderDetailColumns;
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ preferences: { themeMode: 'light', tabletMode: false, uiVariant: 'workbench', orderDetailColumns: saved } }),
            });
        });

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        const table = page.locator('.orders-table');
        await expect(table.locator('tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });
        const headers = () => table.locator('thead th').evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim()).filter(Boolean));
        // расклад прежнего интерфейса не подменяет список NewLine
        await page.waitForTimeout(1500);
        expect(await headers()).toEqual(expect.arrayContaining(['Статус заказа', 'Статус оплаты', 'Сумма, итого', 'Этапы']));

        // свой расклад NewLine: сохраняется под отдельным ключом и после перезагрузки рисуется сразу
        saved = { ...saved, 'orderList.workbench': { order: ['order_name', 'doweling_order_name', 'order_date', 'client_name', 'film_name'], hidden: hiddenInOldUi } };
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(table.locator('tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });
        await expect.poll(headers).not.toContain('Статус заказа');
        expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('erp.columnSettings.orderList.workbench')))).toHaveLength(1);
        const sparse = await table.evaluate((element) => {
            const width = (title: string) => {
                const th = [...element.querySelectorAll('thead th')].find((cell) => cell.textContent?.trim() === title);
                return th ? Math.round(th.getBoundingClientRect().width) : null;
            };
            return { basis: width('Базис-проект'), date: width('Дата заказа'), client: width('Клиент'), film: width('Пленка'), table: Math.round(element.getBoundingClientRect().width) };
        });
        await shot(page, 'orders-list-own-layout');
        // при скрытых колонках свободное место не достаётся одной «Базис-проект»
        expect(sparse.basis! - sparse.date!).toBeLessThanOrEqual(40);

        let defaultDrawn = false;
        await page.exposeFunction('reportHeaders', (titles: string[]) => { if (titles.includes('Статус заказа')) defaultDrawn = true; });
        await page.addInitScript(() => {
            const observer = new MutationObserver(() => {
                const titles = [...document.querySelectorAll('.orders-table thead th')].map((cell) => cell.textContent?.trim() ?? '');
                if (titles.length > 0) (window as unknown as { reportHeaders: (titles: string[]) => void }).reportHeaders(titles);
            });
            document.addEventListener('DOMContentLoaded', () => observer.observe(document.body, { childList: true, subtree: true }));
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(table.locator('tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });
        await page.waitForTimeout(1000);
        // расклад по умолчанию не мелькает перед сохранённым
        expect(defaultDrawn).toBe(false);
    });

    test('order card follows the NewLine layout and keeps every section and action', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        const tabs = page.getByRole('tablist', { name: 'Секции заказа' });
        await expect(tabs).toBeVisible({ timeout: 60000 });

        // шапка страницы: заголовок, статусы, клиент, действия
        const head = page.locator('.wb-order-head');
        await expect(head.locator('h1')).toHaveText('Заказ Тест-2972');
        await expect(head.locator('.wb-pill').first()).toHaveText('В производстве');
        await expect(head.locator('.wb-pill').nth(1)).toHaveText('Частично оплачен');
        await expect(head.locator('.wb-order-head__client')).toHaveText('Базовый клиент');
        const actions = head.locator('.wb-order-head__actions');
        await expect(actions.getByRole('button', { name: 'Добавить платёж' })).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Изменить' })).toBeVisible();
        await actions.getByRole('button', { name: /Печать/ }).click();
        for (const item of ['Печать', 'Экспорт в Excel', 'PDF для производства', 'Excel для производства', 'JSON snapshot']) {
            await expect(page.getByRole('menuitem', { name: item })).toBeVisible();
        }
        await page.keyboard.press('Escape');
        await actions.getByRole('button', { name: 'Ещё действия' }).click();
        await expect(page.getByRole('menuitem', { name: 'Обновить' })).toBeVisible();
        await page.keyboard.press('Escape');

        // плитки показателей
        for (const label of ['Сумма', 'Оплачено', 'Срок выполнения', 'Состав', 'Материал']) {
            await expect(head.locator('.wb-order-head__label', { hasText: label })).toBeVisible();
        }
        await expect(head).toContainText('скидка');
        await expect(head).toContainText('остаток');

        // компактные размеры: плитки показателей и свёрнутый «Ход производства»
        const tileHeight = await head.locator('.wb-order-head__tiles').evaluate((element) => Math.round(element.getBoundingClientRect().height));
        expect(tileHeight).toBeLessThanOrEqual(88);
        const flowHeight = await page.locator('.wb-order-flow').evaluate((element) => Math.round(element.getBoundingClientRect().height));
        expect(flowHeight).toBeLessThanOrEqual(30);

        // вкладки: «Детали» + прежние пять секций; открыта таблица деталей
        await expect(tabs.getByRole('tab')).toHaveText([/Детали/, ...ORIGINAL_SECTIONS.map((name) => new RegExp(name))]);
        await expect(tabs.getByRole('tab', { name: /Детали/ })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.order-show-details-table')).toBeVisible();
        await expect(page.locator('.order-show-info-panel')).toHaveCount(0);

        // «Ход производства» — спойлер, по умолчанию свёрнут
        const flowToggle = page.getByRole('button', { name: /Ход производства/ });
        await expect(flowToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(page.locator('.order-production-flow')).toHaveCount(0);

        // правая колонка
        const side = page.locator('.wb-order-side');
        for (const title of ['Клиент', 'Сроки', 'Связи', 'Примечание']) {
            await expect(side.getByRole('heading', { name: title })).toBeVisible();
        }
        await expect(side).toContainText('Фасады кухни, срочно к пятнице');
        await shot(page, 'order-card');

        await flowToggle.click();
        const flow = page.locator('.order-production-flow');
        await expect(flow).toBeVisible();
        await expect(flow.locator('.order-production-flow__stage', { hasText: 'Распилен' })).toContainText('2 поз. · 5 шт.');
        await expect(flow.locator('.order-production-flow__stage', { hasText: 'Закатан' })).toContainText('1 поз. · 1 шт.');
        await expect(flow.locator('.order-production-flow__stage', { hasText: 'Упакован' })).toHaveAttribute('data-empty', 'true');
        await expect(flow).toContainText('Всего 3 поз. · 6 шт.');
        await shot(page, 'order-card-flow');
        await flowToggle.click();
        await expect(flow).toHaveCount(0);

        // секция заменяет таблицу деталей, «Детали» возвращает её
        await tabs.getByRole('tab', { name: 'Финансы' }).click();
        await expect(page.locator('.order-show-info-panel')).toBeVisible();
        await expect(page.locator('.order-show-details-table')).toBeHidden();
        await expect(page.locator('.order-show-details-toolbar')).toBeHidden();
        await shot(page, 'order-card-finance');
        // «Дополнительная информация»: материалы заказа сверху, остальные блоки ниже на всю ширину
        await tabs.getByRole('tab', { name: 'Дополнительная информация' }).click();
        const additional = page.locator('.order-additional');
        await expect(additional).toBeVisible();
        const layout = await additional.evaluate((root) => {
            const box = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
            const blocks = [
                ...root.querySelectorAll('.order-additional__summary > div, .order-additional__extras > *'),
            ].map((element) => element.getBoundingClientRect());
            const rootBox = root.getBoundingClientRect();
            const rows = new Map<number, { left: number; right: number }>();
            blocks.forEach((block) => {
                const key = Math.round(block.top);
                const row = rows.get(key) ?? { left: block.left, right: block.right };
                rows.set(key, { left: Math.min(row.left, block.left), right: Math.max(row.right, block.right) });
            });
            return {
                materialsTop: box('.order-additional__materials').top,
                firstBlockTop: Math.min(...blocks.map((block) => block.top)),
                gaps: [...rows.values()].map((row) => Math.round((row.left - rootBox.left) + (rootBox.right - row.right))),
            };
        });
        expect(layout.materialsTop).toBeLessThan(layout.firstBlockTop);
        // каждая строка блоков занимает всю ширину вкладки
        layout.gaps.forEach((gap) => expect(gap).toBeLessThanOrEqual(2));
        for (const title of ['Материалы заказа', 'Даты', 'Производство', 'Присадки', 'Файлы', 'Служебная информация']) {
            await expect(additional.getByText(title, { exact: true }).first()).toBeVisible();
        }
        // материалы: одна шапка на плёнку и листовые, колонка «Ванны», строки одной высоты
        const materials = additional.locator('.wb-materials__table');
        await expect(materials.locator('thead tr')).toHaveCount(1);
        await expect(materials.locator('thead th')).toContainText(['Материал', 'м²', 'Детали', 'Пог. м', 'Листы', 'Ванны']);
        await expect(materials.locator('.wb-materials__section')).toHaveText([/Плёнка/, /Листовые материалы/]);
        const rowHeights = await materials.locator('tbody tr:not(.wb-materials__section)').evaluateAll(
            (rows) => rows.map((row) => Math.round(row.getBoundingClientRect().height)),
        );
        expect(new Set(rowHeights).size).toBe(1);
        // «История» — отдельный спойлер, по умолчанию свёрнут; записи берутся из журнала истории по заказу
        const history = additional.locator('.order-history');
        const historyToggle = history.getByRole('button', { name: /История/ });
        await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(history.locator('.order-history__item')).toHaveCount(0);
        await historyToggle.click();
        await expect(history.locator('.order-history__item')).toHaveCount(2);
        await expect(history.locator('.order-history__item').first()).toContainText('01.10.2026');
        await expect(history.locator('.order-history__count')).toHaveText('2');
        // записи прокручиваются внутри блока и не удлиняют страницу
        const historyBox = await history.locator('.order-history__body').evaluate((element) => {
            const style = getComputedStyle(element);
            return { overflowY: style.overflowY, maxHeight: style.maxHeight };
        });
        expect(historyBox).toEqual({ overflowY: 'auto', maxHeight: '420px' });
        await shot(page, 'order-card-additional');
        await historyToggle.click();
        await expect(history.locator('.order-history__item')).toHaveCount(0);

        await tabs.getByRole('tab', { name: /Детали/ }).click();
        await expect(page.locator('.order-show-info-panel')).toHaveCount(0);
        await expect(page.locator('.order-show-details-table')).toBeVisible();

        // свёрнутый «Ход производства» показывает коды этапов с числом деталей
        const codes = page.locator('.order-production-flow-codes__item');
        await expect(codes).toHaveCount(7);
        await expect(codes.filter({ hasText: /^Р\s*5$/ })).toHaveCount(1);
        await expect(codes.filter({ hasText: /^З\s*1$/ })).toHaveCount(1);

        // колонка ХДФ скрыта, пока в заказе нет ХДФ
        await expect(page.locator('.order-show-details-table thead th', { hasText: /^ХДФ$/ })).toHaveCount(0);

        // группировка: у каждой группы, включая первую, заголовок «по чему разбито: значение»
        await page.getByRole('button', { name: /Группировать/ }).click();
        await page.getByRole('menuitem', { name: 'по статусу' }).click();
        const separation = page.getByRole('checkbox', { name: 'Разделение на группы' });
        if (!(await separation.isChecked())) await separation.check();
        const groupHeads = page.locator('.order-show-details-table .wb-group-head');
        await expect(groupHeads).toHaveCount(2);
        await expect(groupHeads.nth(0)).toContainText('Статус');
        await expect(groupHeads.nth(0)).toContainText('Распилен');
        await expect(groupHeads.nth(0)).toContainText('2 поз.');
        await expect(groupHeads.nth(1)).toContainText('Закатан');
        const firstRowKind = await page.locator('.order-show-details-table .ant-table-tbody > tr.ant-table-row').first().getAttribute('class');
        expect(firstRowKind).toContain('detail-group-separator');
        await shot(page, 'order-card-grouped');

        // правая колонка сворачивается, таблица деталей занимает освободившуюся ширину
        const tableWidth = () => page.locator('.order-show-details-section').evaluate((element) => Math.round(element.getBoundingClientRect().width));
        const widthWithSide = await tableWidth();
        await page.getByRole('button', { name: 'Свернуть боковую панель' }).click();
        await expect(side).toBeHidden();
        expect(await tableWidth()).toBeGreaterThan(widthWithSide + 250);
        // от свёрнутой колонки остаётся тонкая линия, которой её можно вернуть
        const rail = page.locator('.wb-order-side-rail');
        await expect(rail).toBeVisible();
        expect(await rail.evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBeLessThanOrEqual(32);
        await shot(page, 'order-card-wide');
        // выбор запоминается в браузере (мок-окружение очищает localStorage при загрузке, поэтому без reload)
        expect(await page.evaluate(() => localStorage.getItem('erp.orderShow.sideCollapsed'))).toBe('1');
        await page.getByRole('button', { name: 'Показать боковую панель' }).click();
        await expect(side).toBeVisible();
        expect(await page.evaluate(() => localStorage.getItem('erp.orderShow.sideCollapsed'))).toBe('0');
        expect(pageErrors).toEqual([]);
    });

    test('compact bar replaces the head while scrolling and stays below the app chrome', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 520 });
        await openWithVariant(page, 'workbench');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.wb-order-head h1')).toBeVisible({ timeout: 60000 });
        const slot = page.locator('.wb-order-bar-slot');
        await expect(slot).toHaveAttribute('data-on', 'false');

        await page.locator('.order-show-details-table').scrollIntoViewIfNeeded();
        await page.mouse.wheel(0, 500);
        await expect(slot).toHaveAttribute('data-on', 'true');
        // строка появляется с короткой анимацией сдвига — меряем после неё
        const readOffset = () => page.evaluate(() => {
            const bar = document.querySelector('.wb-order-bar')!.getBoundingClientRect();
            const tabs = document.querySelector('.workspace-tabs')!.getBoundingClientRect();
            return Math.round(bar.top) - Math.round(tabs.bottom);
        });
        await expect.poll(readOffset, { timeout: 5000 }).toBeGreaterThanOrEqual(-1);
        expect(await readOffset()).toBeLessThanOrEqual(2);
        const bar = page.locator('.wb-order-bar');
        await expect(bar).toContainText('Заказ Тест-2972');
        // липкая строка — белая, с контуром темнее обычной серой линии
        const barLook = await bar.evaluate((element) => {
            const style = getComputedStyle(element);
            return { background: style.backgroundColor, line: style.borderBottomColor };
        });
        expect(barLook.background).toBe('rgb(255, 255, 255)');
        expect(barLook.line).not.toBe('rgb(228, 231, 236)');
        // состав и оплата видны при прокрутке
        await expect(bar).toContainText('6 дет.');
        await expect(bar).toContainText('м²');
        await expect(bar).toContainText('160 381');
        await expect(bar).toContainText('остаток 100 381');
        // статусы в строке не обрезаются
        for (const pill of await bar.locator('.wb-pill').all()) {
            expect(await pill.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
        }
        const overflow = await bar.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        await expect(bar.getByRole('button', { name: 'Изменить' })).toBeVisible();
        await shot(page, 'order-card-scrolled');
    });

    test('dark theme keeps the card readable', async ({ page }) => {
        await openWithVariant(page, 'workbench', 'dark');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        const tabs = page.getByRole('tablist', { name: 'Секции заказа' });
        await expect(tabs).toBeVisible({ timeout: 60000 });
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await page.getByRole('button', { name: /Ход производства/ }).click();
        await expect(page.locator('.order-production-flow')).toBeVisible();
        await shot(page, 'order-card-dark');

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.orders-table tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });
        await shot(page, 'orders-list-dark');
    });

    test('shell: one top bar with tabs and utilities, search and collapse live in the sidebar', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench');

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.orders-table tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });

        const topbar = page.locator('.wb-topbar');
        await expect(topbar).toBeVisible();
        await expect(page.locator('.evolution-header')).toHaveCount(0);
        await expect(topbar.locator('.workspace-tabs')).toBeVisible();
        await expect(topbar.getByRole('tab', { name: 'Заказы' })).toBeVisible();
        await expect(topbar.getByRole('button', { name: /Меню пользователя/ })).toBeVisible();
        await expect(topbar.getByRole('switch', { name: 'Переключить тему' })).toBeVisible();
        // панель одна и её высота совпадает с высотой вкладок: от неё страницы считают липкие отступы
        const heights = await page.evaluate(() => ({
            bar: Math.round(document.querySelector('.wb-topbar')!.getBoundingClientRect().height),
            tabs: Math.round(document.querySelector('.workspace-tabs')!.getBoundingClientRect().height),
        }));
        expect(heights.bar).toBe(48);
        expect(heights.tabs).toBe(48);

        const sider = page.locator('.evolution-sider');
        await sider.getByRole('button', { name: 'Открыть быстрый переход' }).click();
        await expect(page.getByRole('combobox').first()).toBeVisible();
        await page.keyboard.press('Escape');

        // группы меню сворачиваются
        const group = sider.locator('.evolution-sider__group').first();
        const toggle = group.locator('.evolution-sider__group-toggle');
        const itemsBefore = await group.locator('.ant-menu-item').count();
        expect(itemsBefore).toBeGreaterThan(0);
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        await expect(group.locator('.ant-menu-item')).toHaveCount(0);
        await toggle.click();
        await expect(group.locator('.ant-menu-item')).toHaveCount(itemsBefore);
        await shot(page, 'shell');

        await sider.getByRole('button', { name: 'Свернуть меню' }).click();
        await expect(page.locator('.evolution-shell--collapsed')).toBeVisible();
        await shot(page, 'shell-collapsed');
        await sider.getByRole('button', { name: 'Развернуть меню' }).click();
        await expect(page.locator('.evolution-shell--collapsed')).toHaveCount(0);
        expect(pageErrors).toEqual([]);
    });

    test('shell: the top bar grows with wrapped tab rows and the screen starts below it', async ({ page }) => {
        await openWithVariant(page, 'workbench');
        await page.setViewportSize({ width: 1100, height: 900 });

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.orders-table tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });

        const measure = () => page.evaluate(() => {
            const bar = document.querySelector('.wb-topbar')!.getBoundingClientRect();
            const tabs = [...document.querySelectorAll('.wb-topbar .ant-tabs-tab')].map((tab) => tab.getBoundingClientRect());
            const content = document.querySelector('.evolution-shell__content')!;
            return {
                barBottom: Math.round(bar.bottom),
                barHeight: Math.round(bar.height),
                tabsHeight: Math.round(document.querySelector('.wb-topbar .workspace-tabs')!.getBoundingClientRect().height),
                rows: new Set(tabs.map((tab) => Math.round(tab.top))).size,
                lastTabBottom: Math.round(Math.max(...tabs.map((tab) => tab.bottom))),
                contentTop: Math.round(content.getBoundingClientRect().top),
                background: getComputedStyle(document.querySelector('.wb-topbar')!).backgroundColor,
            };
        });

        const items = page.locator('.evolution-sider .ant-menu-item');
        const total = await items.count();
        let state = await measure();
        for (let index = 0; index < total && state.rows < 3; index += 1) {
            await items.nth(index).click();
            await page.waitForTimeout(250);
            state = await measure();
        }

        expect(state.rows).toBeGreaterThanOrEqual(3);
        // все строки вкладок лежат внутри панели с фоном, экран начинается под ней
        expect(state.barHeight).toBeGreaterThan(48 + 32);
        expect(state.lastTabBottom).toBeLessThanOrEqual(state.barBottom);
        expect(state.contentTop).toBeGreaterThanOrEqual(state.barBottom);
        expect(state.background).not.toBe('rgba(0, 0, 0, 0)');
        await shot(page, 'shell-tabs-wrapped');

        // липкие строки страниц считают отступ от высоты вкладок — она равна высоте всей панели
        expect(state.tabsHeight).toBe(state.barHeight);
    });

    test('order card: «Раскрой» — jobs list on the left, the open job on the right', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench', 'light', { cut: true });
        const cutJob = (cutJobId: number, name: string, status: string) => ({
            cutJobId, displayNumber: String(cutJobId), isVacuum: false, name, status, source: 'manual',
            createdAt: `2026-09-2${cutJobId}T08:30:00.000Z`, version: 1, pdfPrewarmState: 'pending', paramProfileId: null,
            sheetMaterialTypeId: null, pdfTemplate: 'standard', combineFilms: false, splitByMaterial: true, rotationAllowed: true,
            textureDirection: 'none', materialNames: ['МДФ 16 мм'],
            totals: { positions: 4, details: 12 + cutJobId, area: 3.4, sheets: 2, materialsCount: 1, filmsCount: 1 },
            items: [], groups: [],
        });
        const jobs = [cutJob(1, 'E2E-Тест раскрой кухня', 'ready'), cutJob(2, 'E2E-Тест раскрой шкаф', 'draft')];
        const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        await page.route(/\/api\/v1\/cut-jobs(\?.*)?$/, (route) => route.fulfill(json(jobs)));
        await page.route(/\/api\/v1\/cut-jobs\/placements(\?.*)?$/, (route) => route.fulfill(json({
            jobs: jobs.map((item) => ({ cutJobId: item.cutJobId, name: item.name, paramProfileId: null, profileName: null, profileIsActive: null })),
            hasArchived: false,
        })));
        const eligibleDetail = (orderDetailId: number) => ({
            orderDetailId, orderId: 15, orderName: 'Тест-2972', clientName: 'Базовый клиент', detailNumber: orderDetailId,
            detailName: null, height: 500, width: 400, quantity: 1, area: 0.2, materialId: null, sheetMaterialTypeId: 7,
            materialName: 'МДФ 16 мм', millingTypeName: null, edgeTypeName: null, filmId: null, filmName: null,
            productionStatusName: null, priority: null, jointOrderId: null, note: null, linkCuttingFile: null,
            linkCuttingImageFile: null, linkCadFile: null, linkPdfFile: null, eligible: true, ineligibleReason: null,
            placements: [],
        });
        await page.route(/\/api\/v1\/cut-jobs\/eligible-details(\?.*)?$/, (route) => route.fulfill(json({
            details: [eligibleDetail(1), eligibleDetail(2)], noSheetSpecCount: 0,
        })));
        await page.route(/\/api\/v1\/cut-jobs\/(1|2)$/, (route) => {
            const id = Number(route.request().url().split('/').pop());
            return route.fulfill(json(jobs.find((item) => item.cutJobId === id)));
        });

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        await page.getByRole('tablist', { name: 'Секции заказа' }).getByRole('tab', { name: /Раскрой/ }).click({ timeout: 60000 });

        const rail = page.locator('.cut-page-modern--wb-split .cut-page-modern__jobs');
        const cards = rail.getByTestId('cut-job-card');
        await expect(cards).toHaveCount(2, { timeout: 60000 });
        await expect(rail.locator('.cut-jobs-table')).toHaveCount(0);
        // фильтры и действия списка — в самом списке
        const filters = rail.locator('.wb-cut-rail__filters');
        await expect(filters.getByText('Показывать удалённые')).toBeVisible();
        await expect(filters.getByRole('button', { name: 'Обновить' })).toBeVisible();
        // загрузка SVG в карточке заказа не нужна
        await expect(rail.getByRole('button', { name: 'SVG' })).toHaveCount(0);

        // первое задание открывается само; его содержимое — справа от списка
        const jobCard = page.locator('.cut-page-modern__job');
        await expect(jobCard).toBeVisible({ timeout: 30000 });
        await expect(cards.first()).toHaveAttribute('data-active', 'true');
        await expect(jobCard).toContainText('E2E-Тест раскрой кухня');
        const layout = await page.evaluate(() => {
            const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            const railRect = rect('.cut-page-modern__jobs');
            const jobRect = rect('.cut-page-modern__job');
            return {
                railWidth: Math.round(railRect.width),
                jobLeftOfRail: jobRect.left < railRect.right,
                sameRow: Math.abs(jobRect.top - railRect.top) < 4,
                overflow: [...document.querySelectorAll('[data-testid="cut-job-card"]')].map((card) => card.scrollWidth - card.clientWidth),
            };
        });
        expect(layout.railWidth).toBe(212);
        expect(layout.jobLeftOfRail).toBe(false);
        expect(layout.sameRow).toBe(true);
        for (const overflow of layout.overflow) expect(overflow).toBeLessThanOrEqual(1);
        await shot(page, 'order-card-cut');

        // клик по другому заданию показывает его справа
        await cards.nth(1).locator('.wb-cut-job__name').click();
        await expect(jobCard).toContainText('E2E-Тест раскрой шкаф', { timeout: 30000 });
        await expect(cards.nth(1)).toHaveAttribute('data-active', 'true');

        // подбор деталей можно отменить: блок со списком исчезает, выбор сброшен, список заданий как был
        await page.getByRole('button', { name: 'Подбор деталей на раскрой' }).click();
        const preview = page.locator('.cut-page-modern__creation');
        await expect(preview).toBeVisible({ timeout: 30000 });
        await expect(preview).toContainText('Выбрано: 2');
        await expect(jobCard).toHaveCount(0);
        // пока идёт подбор, существующее задание само не открывается поверх него
        await page.waitForTimeout(1500);
        await expect(preview).toBeVisible();
        await preview.getByRole('button', { name: 'Отмена' }).click();
        await expect(preview).toHaveCount(0);
        await expect(page.locator('.cut-page-modern__eligible')).toHaveCount(0);
        await expect(jobCard).toBeVisible({ timeout: 30000 });
        await expect(cards).toHaveCount(2);
        expect(pageErrors).toEqual([]);
    });

    test('other variants keep the separate header and tabs rows', async ({ page }) => {
        await openWithVariant(page, 'evolution');

        await page.goto('/orders', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.orders-table tr[data-row-key="15"]')).toBeVisible({ timeout: 60000 });
        await expect(page.locator('.wb-topbar')).toHaveCount(0);
        await expect(page.locator('.evolution-header')).toBeVisible();
        await expect(page.locator('.evolution-header').getByRole('button', { name: 'Открыть быстрый переход' })).toBeVisible();
        await expect(page.locator('.evolution-sider__search')).toHaveCount(0);
        await expect(page.locator('.evolution-sider__collapse')).toBeVisible();
    });

    test('order form: NewLine head with the same actions and tabs', async ({ page }) => {
        const pageErrors = await openWithVariant(page, 'workbench');

        await page.goto('/orders/edit/15', { waitUntil: 'domcontentloaded' });
        const head = page.locator('.order-form-page--workbench .wb-order-head');
        await expect(head.locator('h1')).toHaveText('Редактирование заказа «Тест-2972»', { timeout: 60000 });
        await expect(page.locator('.order-form-card .ant-card-head')).toHaveCount(0);
        const actions = head.locator('.wb-order-head__actions');
        await expect(actions.getByRole('button', { name: 'Просмотр' })).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Закрыть' })).toBeVisible();
        const save = actions.getByRole('button', { name: 'Сохранить' });
        await expect(save).toBeVisible();
        // (в мок-окружении заказ считается изменённым сразу и в прежней форме, поэтому состояние кнопки здесь не проверяется)
        // «Сохранить» стоит последней
        const order = await actions.locator('.order-form-action').evaluateAll(
            (buttons) => buttons
                .map((button) => ({ left: button.getBoundingClientRect().left, text: (button as HTMLElement).innerText.trim() }))
                .sort((a, b) => a.left - b.left)
                .map((button) => button.text),
        );
        expect(order[order.length - 1]).toBe('Сохранить');

        for (const label of ['Сумма', 'Оплачено', 'Срок выполнения', 'Состав', 'Материал', 'Общие параметры']) {
            await expect(head.locator('.wb-order-head__label', { hasText: label })).toBeVisible();
        }
        // гибрид: основные разделы на одной странице, без вкладок
        await expect(page.locator('.order-form-page--workbench .ant-tabs')).toHaveCount(0);
        const anchors = page.locator('.wb-form-anchors__item');
        await expect(anchors).toContainText(['Клиент и срок', 'Детали заказа', 'Услуги и товары', 'Финансы', 'ХДФ', 'Материалы', 'Дополнительно']);
        const mainSections = page.locator('.wb-form-section:not(.wb-form-section--fold)');
        await expect(mainSections).toHaveCount(4);
        await expect(mainSections.locator('.wb-form-section__title')).toHaveText([/Клиент и срок/, /Детали заказа/, /Услуги и товары/, /Финансы/]);
        // таблица деталей и финансы видны сразу, без переключения
        await expect(page.locator('.order-form-details-section')).toBeVisible();
        await expect(mainSections.nth(3)).toContainText('Сумма заказа');
        await shot(page, 'order-form');

        // редкие разделы — сворачиваемые секции, по умолчанию закрыты
        const folds = page.locator('.wb-form-section--fold');
        const additionalFold = folds.filter({ hasText: 'Дополнительно' });
        const additionalToggle = additionalFold.getByRole('button', { name: /Дополнительно/ });
        await expect(additionalToggle).toHaveAttribute('aria-expanded', 'false');
        await expect(additionalFold.locator('.wb-form-section__body')).toHaveCount(0);
        await additionalToggle.click();
        await expect(additionalToggle).toHaveAttribute('aria-expanded', 'true');
        await expect(additionalFold.locator('.wb-form-section__body')).toBeVisible();
        await additionalToggle.click();
        await expect(additionalFold.locator('.wb-form-section__body')).toHaveCount(0);

        // якорь открывает раздел и прокручивает к нему
        await anchors.filter({ hasText: 'Финансы' }).click();
        await expect(mainSections.nth(3)).toBeInViewport();
        // якоря остаются на экране под сжатой шапкой — белой полосой с чётким контуром
        const stickyRows = () => page.evaluate(() => {
            const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
            const nav = document.querySelector('.wb-form-anchors')!;
            const style = getComputedStyle(nav);
            return {
                gap: Math.round(rect('.wb-form-anchors').top - rect('.wb-order-bar').bottom),
                barTop: Math.round(rect('.wb-order-bar').top - rect('.wb-topbar').bottom),
                stuck: nav.getAttribute('data-stuck'),
                background: style.backgroundColor,
                line: style.borderBottomColor,
                barBackground: getComputedStyle(document.querySelector('.wb-order-bar')!).backgroundColor,
            };
        });
        await expect.poll(async () => (await stickyRows()).stuck, { timeout: 5000 }).toBe('true');
        await expect.poll(async () => Math.abs((await stickyRows()).gap), { timeout: 5000 }).toBeLessThanOrEqual(1);
        const rows = await stickyRows();
        expect(Math.abs(rows.barTop)).toBeLessThanOrEqual(1);
        expect(rows.background).toBe('rgb(255, 255, 255)');
        expect(rows.barBackground).toBe('rgb(255, 255, 255)');
        expect(rows.line).not.toBe('rgb(228, 231, 236)');
        await expect(anchors.filter({ hasText: 'Финансы' })).toHaveAttribute('aria-current', 'true');
        // раздел встаёт вплотную под липкие строки — предыдущий блок не остаётся на экране
        const sectionGap = (title: RegExp) => page.evaluate((source) => {
            const pattern = new RegExp(source);
            const section = [...document.querySelectorAll('.wb-form-section')]
                .find((node) => pattern.test(node.querySelector('.wb-form-section__title')?.textContent ?? ''))!;
            return Math.round(section.getBoundingClientRect().top - document.querySelector('.wb-form-anchors')!.getBoundingClientRect().bottom);
        }, title.source);
        await expect.poll(() => sectionGap(/Финансы/), { timeout: 8000 }).toBeLessThanOrEqual(12);
        expect(await sectionGap(/Финансы/)).toBeGreaterThanOrEqual(0);
        await anchors.filter({ hasText: 'Дополнительно' }).click();
        await expect.poll(() => sectionGap(/Дополнительно/), { timeout: 8000 }).toBeLessThanOrEqual(12);
        expect(await sectionGap(/Дополнительно/)).toBeGreaterThanOrEqual(0);
        await shot(page, 'order-form-last-section');
        await anchors.filter({ hasText: 'Финансы' }).click();
        await expect.poll(() => sectionGap(/Финансы/), { timeout: 8000 }).toBeLessThanOrEqual(12);
        for (const label of ['Клиент и срок', 'Финансы', 'Дополнительно']) {
            await expect(anchors.filter({ hasText: label })).toBeInViewport();
        }
        await shot(page, 'order-form-finance');
        expect(pageErrors).toEqual([]);
    });

    test('order form in other variants keeps the card title and buttons', async ({ page }) => {
        await openWithVariant(page, 'evolution');

        await page.goto('/orders/edit/15', { waitUntil: 'domcontentloaded' });
        const cardHead = page.locator('.order-form-card .ant-card-head');
        await expect(cardHead).toContainText('Редактирование заказа «Тест-2972»', { timeout: 60000 });
        await expect(cardHead.getByRole('button', { name: 'Сохранить' })).toBeVisible();
        await expect(page.locator('.wb-order-head')).toHaveCount(0);
        await expect(page.locator('.wb-order-bar-slot')).toHaveCount(0);
    });

    test('other variants keep the original five sections', async ({ page }) => {
        await openWithVariant(page, 'evolution');

        await page.goto('/orders/show/15', { waitUntil: 'domcontentloaded' });
        const tabs = page.getByRole('tablist', { name: 'Секции заказа' });
        await expect(tabs).toBeVisible({ timeout: 60000 });
        await expect(tabs.getByRole('tab')).toHaveText(ORIGINAL_SECTIONS.map((name) => new RegExp(name)));
    });
});

async function shot(page: Page, name: string) {
    if (!shotsDir) return;
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${shotsDir}/${name}.png` });
}

async function openWithVariant(
    page: Page,
    uiVariant: 'workbench' | 'evolution',
    themeMode: 'light' | 'dark' = 'light',
    extra: { cut?: boolean } = {},
) {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const db = createWorkflowMockDb();
    seed(db);
    await setupWorkflowMockApi(page, db, {
        uiVariant,
        themeMode,
        ...(extra.cut ? {
            runtimeConfig: { backendCut: true },
            authUser: {
                id: '1', user_id: 1, username: 'admin', role: 'admin', role_id: 1,
                permissions: ['orders.view', 'orders.create', 'orders.update', 'payments.view', 'clients.view', 'settings.view', 'cut.view', 'cut.manage'],
            },
        } : {}),
    });
    if (themeMode === 'dark') {
        await page.addInitScript(() => {
            localStorage.setItem('erp.themeMode.1', 'dark');
        });
    }
    await page.route(/\/api\/vlm\/health$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, providerConfigured: false, limits: { maxUploadMb: 20, allowedMimeTypes: ['image/jpeg'] } }),
        });
    });
    // без права на журнал история читается из GET /orders/:id/history (закрытая проекция событий)
    await page.route(/\/api\/v1\/orders\/15\/history(\?.*)?$/, async (route) => {
        const event = (auditId: string, name: string, createdAt: string) => ({
            auditId, event: name, createdAt, actorName: 'admin', entityType: 'order', statusField: null, statusName: null, stageCode: null,
        });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                data: [event('a2', 'order.updated', '2026-10-01T12:30:00+05:00'), event('a1', 'order.created', '2026-09-25T10:00:00+05:00')],
                pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
            }),
        });
    });
    await page.route(/\/api\/v1\/audit\?.*orderIds=15/, async (route) => {
        const event = (auditId: string, name: string, createdAt: string) => ({
            auditId, event: name, entityType: 'order', entityId: '15', entityName: 'Тест-2972', entityDetailNumber: null,
            userId: 1, username: 'admin', role: 'admin', source: 'ui', relatedOrderId: 15, relatedOrderName: 'Тест-2972',
            relatedClientId: null, relatedClientName: null, relatedPaymentId: null, relatedDeadlineId: null,
            relatedProductionEventId: null, relatedUserId: null, relatedEntities: [], statusField: null, statusId: null,
            statusName: null, statusCode: null, stageCode: null, requestId: `req-${auditId}`, ip: null, userAgent: null,
            before: null, after: null, diff: null, metadata: null, createdAt,
        });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                data: [event('a2', 'order.updated', '2026-10-01T12:30:00+05:00'), event('a1', 'order.created', '2026-09-25T10:00:00+05:00')],
                pagination: { page: 1, pageSize: 20, total: 2, totalPages: 1 },
                requestId: 'audit-list',
            }),
        });
    });
    await page.route(/\/api\/v1\/notifications(?:\?.*)?$/, async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ data: [], pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 }, unreadCount: 0 }),
        });
    });
    return pageErrors;
}

function seed(db: WorkflowMockDb) {
    db.order_statuses.splice(0, db.order_statuses.length,
        { order_status_id: 1, order_status_name: 'Предварительный', sort_order: 10, color: 'blue', is_active: true },
        { order_status_id: 2, order_status_name: 'В производстве', sort_order: 20, color: 'blue', is_active: true },
        { order_status_id: 3, order_status_name: 'Готов к выдаче', sort_order: 30, color: 'green', is_active: true },
    );
    db.payment_statuses.splice(0, db.payment_statuses.length,
        { payment_status_id: 1, payment_status_name: 'Не оплачен', sort_order: 10, color: 'red', is_active: true },
        { payment_status_id: 2, payment_status_name: 'Частично оплачен', sort_order: 20, color: 'orange', is_active: true },
        { payment_status_id: 3, payment_status_name: 'Оплачен', sort_order: 30, color: 'green', is_active: true },
    );
    db.production_statuses.splice(0, db.production_statuses.length,
        { production_status_id: 1, production_status_code: 'new', production_status_name: 'Новый', sort_order: 10, color: 'blue', is_active: true },
        { production_status_id: 2, production_status_code: 'drawn', production_status_name: 'Отрисован', sort_order: 20, color: 'blue', is_active: true },
        { production_status_id: 3, production_status_code: 'cut', production_status_name: 'Распилен', sort_order: 30, color: 'orange', is_active: true },
        { production_status_id: 4, production_status_code: 'sanded', production_status_name: 'Отшлифован', sort_order: 40, color: 'orange', is_active: true },
        { production_status_id: 5, production_status_code: 'laminated', production_status_name: 'Закатан', sort_order: 50, color: 'green', is_active: true },
        { production_status_id: 6, production_status_code: 'packed', production_status_name: 'Упакован', sort_order: 60, color: 'green', is_active: true },
        { production_status_id: 7, production_status_code: 'issued', production_status_name: 'Выдан', sort_order: 70, color: 'green', is_active: true },
    );

    const orders: Array<[number, string, number, number, number, number, number, string]> = [
        [15, 'Тест-2972', 2, 2, 3, 160381, 60000, 'Фасады кухни, срочно к пятнице'],
        [16, 'Тест-2971', 1, 1, 1, 84500, 0, ''],
        [17, 'Тест-2970', 3, 3, 6, 231900, 231900, 'Выдача со склада'],
        [18, 'Тест-2969', 2, 2, 5, 47200, 20000, ''],
        [19, 'Тест-2968', 2, 1, 2, 318640, 0, 'Два цвета плёнки'],
        [20, 'Тест-2967', 1, 3, 1, 12900, 12900, ''],
    ];
    orders.forEach(([orderId, name, orderStatusId, paymentStatusId, productionStatusId, total, paid, notes], index) => {
        db.orders.push({
            order_id: orderId,
            order_name: name,
            client_id: 1,
            manager_id: 1,
            order_date: `2026-09-${String(25 - index).padStart(2, '0')}`,
            planned_completion_date: `2026-10-${String(5 + index).padStart(2, '0')}`,
            order_status_id: orderStatusId,
            payment_status_id: paymentStatusId,
            production_status_id: productionStatusId,
            production_status_from_details_enabled: true,
            final_amount: total,
            total_amount: total + (index === 0 ? 5000 : 0),
            paid_amount: paid,
            discount: index === 0 ? 5000 : 0,
            surcharge: 0,
            parts_count: 6,
            total_area: 4.2,
            priority: index === 0 ? 20 : 100,
            notes,
            delete_flag: false,
            version: 3,
            created_at: '2026-09-25T00:00:00+05:00',
            updated_at: '2026-09-25T00:00:00+05:00',
        });
    });

    const details: Array<[number, number, number, number, number]> = [
        [1, 2005, 495, 2, 3],
        [2, 778, 595, 3, 3],
        [3, 726, 595, 1, 5],
    ];
    details.forEach(([detailId, height, width, quantity, productionStatusId]) => {
        db.order_details.push({
            detail_id: detailId,
            order_id: 15,
            detail_number: detailId,
            detail_name: `Тест фасад ${detailId}`,
            height,
            width,
            quantity,
            area: Number(((height * width * quantity) / 1e6).toFixed(2)),
            milling_type_id: 1,
            edge_type_id: 1,
            film_id: 1,
            material_id: null,
            sheet_material_type_id: 1,
            milling_cost_per_sqm: 16900,
            detail_cost: 10000,
            production_status_id: productionStatusId,
            delete_flag: false,
            version: 1,
        });
    });

    db.payments.push({
        payment_id: 1,
        order_id: 15,
        amount: 60000,
        payment_date: '2026-09-25',
        type_paid_id: 1,
        notes: 'Тест предоплата',
        created_at: '2026-09-25T00:00:00+05:00',
        updated_at: '2026-09-25T00:00:00+05:00',
    });
    db.payments_view.push({
        payment_id: 1,
        order_id: 15,
        amount: 60000,
        payment_date: '2026-09-25',
        type_paid_id: 1,
        type_paid_name: 'Наличные',
        order_name: 'Тест-2972',
        client_id: 1,
        client_name: 'Базовый клиент',
        notes: 'Тест предоплата',
    });
}
