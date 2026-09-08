import { expect, test } from '@playwright/test';
import { setupWorkflowMockApi } from './helpers/mockWorkflowApi';

for (const uiVariant of ['legacy', 'air'] as const) {
  test(`${uiVariant}: refresh retains applied cut filters and archive visibility`, async ({ page }) => {
    test.setTimeout(90_000);
    await setupWorkflowMockApi(page, undefined, {
      uiVariant,
      runtimeConfig: { backendCut: true, backendAuth: true, backendPermissions: true },
    });
    const user = { id: '1', userId: 1, username: 'admin', role: 'admin', roleId: 1, permissions: ['cut.view', 'cut.manage', 'orders.view', 'settings.view'] };
    await page.route(/\/api\/v1\/me$/, (route) => route.fulfill({ json: { user } }));
    await page.route(/\/api\/v1\/auth\/refresh$/, (route) => route.fulfill({
      json: { accessToken: 'mock', accessTokenExpiresAt: '2030-01-01T00:00:00.000Z', user },
    }));
    await page.route(/\/api\/v1\/cut-jobs(?:\?.*)?$/, (route) => route.fulfill({ json: [] }));
    await page.route(/\/api\/v1\/cut-jobs\/(?:sheet-types|film-options)(?:\?.*)?$/, (route) => route.fulfill({ json: [] }));
    await page.route(/\/api\/v1\/cut-config$/, (route) => route.fulfill({
      json: { settings: [], paramProfiles: [], renderPresets: [], pdfTemplates: [] },
    }));
    await page.route(/\/api\/v1\/orders(?:\?.*)?$/, (route) => route.fulfill({
      json: { data: [], pagination: { page: 1, pageSize: 200, total: 0, totalPages: 0 } },
    }));
    await page.goto('/cut');
    await expect(page.locator('html')).toHaveAttribute('data-ui-variant', uiVariant);
    const filters = page.getByRole('region', { name: 'Фильтры заданий на раскрой' });
    await filters.getByPlaceholder('2700').fill(' 2700 ');
    // Date inputs are intentionally read-only: use the real calendar popup.
    const month = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });
    await filters.getByPlaceholder('Создано от').click();
    await page.locator(`.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell-in-view[title="${month}-01"]`).first().click();
    await page.locator(`.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell-in-view[title="${month}-07"]`).first().click();
    const listRequest = () => page.waitForRequest((request) => request.method() === 'GET'
      && new URL(request.url()).pathname === '/api/v1/cut-jobs');
    const appliedRequest = listRequest();
    await filters.getByRole('button', { name: /Применить$/ }).click();
    const applied = new URL((await appliedRequest).url()).searchParams;
    expect(applied.get('orderSearch')).toBe('2700');
    expect(applied.get('createdFrom')).toBe(`${month}-01`);
    expect(applied.get('createdTo')).toBe(`${month}-07`);

    // Unapplied draft edits must not replace the last applied criteria either.
    await filters.getByPlaceholder('2700').fill('9999');
    const refresh = page.getByRole('button', { name: uiVariant === 'legacy' ? 'Обновить' : 'Обновить список', exact: true });
    const refreshedRequest = listRequest();
    await refresh.click();
    expect(Object.fromEntries(new URL((await refreshedRequest).url()).searchParams)).toEqual(Object.fromEntries(applied));

    const archivedRequest = listRequest();
    await page.getByRole('checkbox', { name: 'Показывать удалённые' }).check();
    await archivedRequest;
    const archivedRefresh = listRequest();
    await refresh.click();
    expect(Object.fromEntries(new URL((await archivedRefresh).url()).searchParams)).toEqual({ ...Object.fromEntries(applied), includeArchived: 'true' });

    const resetRequest = listRequest();
    await filters.getByRole('button', { name: 'Сбросить', exact: true }).click();
    const reset = new URL((await resetRequest).url()).searchParams;
    expect(reset.get('orderSearch')).toBeNull();
    expect(reset.get('includeArchived')).not.toBe('true');
    const resetRefresh = listRequest();
    await refresh.click();
    expect(Object.fromEntries(new URL((await resetRefresh).url()).searchParams)).toEqual(Object.fromEntries(reset));
  });
}
