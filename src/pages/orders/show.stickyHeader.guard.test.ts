import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const showSource = readFileSync(fileURLToPath(new URL('./show.tsx', import.meta.url)), 'utf8');
const orderFormSource = readFileSync(fileURLToPath(new URL('./components/OrderForm.tsx', import.meta.url)), 'utf8');
const headerSource = readFileSync(fileURLToPath(new URL('./components/sections/OrderShowHeader.tsx', import.meta.url)), 'utf8');
const editHeaderSource = readFileSync(fileURLToPath(new URL('./components/sections/OrderHeaderSummary.tsx', import.meta.url)), 'utf8');
const appCss = readFileSync(fileURLToPath(new URL('../../styles/app.css', import.meta.url)), 'utf8');
const operationalCss = readFileSync(fileURLToPath(new URL('../../ui-operational/operational.css', import.meta.url)), 'utf8');
const operationalHeaderSource = headerSource.match(/if \(isOperational\) \{[\s\S]*?\n  \}\n\n  if \(compactSticky\)/)?.[0] ?? '';
const operationalEditHeaderSource = editHeaderSource.match(/if \(isOperational\) \{[\s\S]*?\n  \}\n\n  return \(/)?.[0] ?? '';
const compactHeaderSource = headerSource.match(/if \(compactSticky\) \{[\s\S]*?\n  \}\n\n  return \(/)?.[0] ?? '';
const compactLineCss = appCss.match(/\.order-show-header__compact-line \{[\s\S]*?\n\}/)?.[0] ?? '';

describe('OrderShow sticky detail header guards', () => {
  it('keeps the order summary, tabs, detail actions, and detail header in the sticky stack', () => {
    expect(showSource).toContain('order-show-summary-tabs-sticky');
    expect(showSource).toContain('order-show-tabs-shell');
    expect(showSource).toContain('order-show-details-toolbar');
    expect(showSource).toContain('order-show-details-table');
    expect(showSource).toContain('orderShowStickyEnabled');
  });

  it('keeps the order edit summary sticky only when the details list exceeds the viewport', () => {
    expect(orderFormSource).toContain('orderFormDetailsBlockRef');
    expect(orderFormSource).toContain('orderFormStickyEnabled');
    expect(orderFormSource).toContain("activeTab === 'details'");
    expect(orderFormSource).toContain('block.scrollHeight > Math.max(320, availableHeight)');
    expect(orderFormSource).toContain('order-show-page--sticky-enabled');
    expect(orderFormSource).toContain('order-show-summary-tabs-sticky');
    expect(orderFormSource).toContain('compactSticky={orderFormStickyEnabled && orderFormSummaryStuck}');
    expect(orderFormSource).toContain('<OrderHeaderSummary compactSticky={orderFormStickyEnabled && orderFormSummaryStuck} />\n              </div>\n              <Tabs');
    expect(orderFormSource).toContain('<OrderHeaderSummary compactSticky={orderFormStickyEnabled && orderFormSummaryStuck} />\n        </div>\n\n        {/* Editable tabs */}\n        <Tabs');
    expect(editHeaderSource).toContain('compactSticky?: boolean');
    expect(editHeaderSource).toContain("order-show-operational-summary--compact");
    expect(editHeaderSource).toContain('order-show-header--compact-sticky');
    expect(operationalCss).toMatch(/\.order-form-operational__workspace[\s\S]*overflow:\s*visible/);
  });

  it('switches the order summary to the compact one-line variant only when stuck', () => {
    expect(headerSource).toContain('compactSticky?: boolean');
    expect(showSource).toContain('compactSticky={orderShowStickyEnabled && orderShowSummaryStuck}');
    expect(headerSource).toContain('order-show-header--compact-sticky');
    expect(headerSource).toContain('order-show-header__compact-line');
  });

  it('shows actual order and payment statuses in the operational summary', () => {
    expect(operationalHeaderSource).toContain("{record?.order_status_name || 'Не назначен'}");
    expect(operationalHeaderSource).toContain("{record?.payment_status_name || 'Не назначен'}");
    expect(operationalHeaderSource).not.toContain("{isAtRisk ? 'Под риском' : 'В работе'}");
    expect(operationalHeaderSource).not.toContain('`${paymentPercent}%`');
  });

  it('shows the same actual statuses in the operational edit summary', () => {
    expect(operationalEditHeaderSource).toContain("{orderStatusData?.data?.order_status_name || 'Не назначен'}");
    expect(operationalEditHeaderSource).toContain("{paymentStatusData?.data?.payment_status_name || 'Не назначен'}");
    expect(operationalEditHeaderSource).not.toContain("{daysToDeadline != null && daysToDeadline < 0 ? 'Под риском' : 'В работе'}");
    expect(operationalEditHeaderSource).not.toContain('`${paymentPercent}%`');
  });

  it('keeps the compact stuck summary dense enough to avoid horizontal scrolling', () => {
    expect(compactHeaderSource).toContain('<StarOutlined aria-hidden');
    expect(headerSource).toContain('paidAmount > 0 ? `опл.');
    expect(compactHeaderSource).toContain('поз.');
    expect(compactHeaderSource).toContain('дет.');
    expect(compactHeaderSource).not.toContain('приоритет {record?.priority');
    expect(compactHeaderSource).not.toContain('оплачено ${formatNumber(paidAmount');
    expect(compactHeaderSource).not.toContain('Примечание: {record?.notes');
    expect(compactHeaderSource).not.toContain('Материал: <Text strong>{materialsSummary}</Text>');
    expect(compactHeaderSource).not.toContain('Площадь: <Text strong>{formatNumber(totals.total_area');
    expect(compactLineCss).toContain('overflow: hidden;');
    expect(compactLineCss).not.toContain('overflow-x: auto;');
  });

  it('shows the doweling order number as Basis project in the order summary without a duplicate material suffix', () => {
    expect(headerSource).toContain('const compactBasisProjectName =');
    expect(editHeaderSource).toContain('const compactBasisProjectName =');
    expect(headerSource).toContain('record?.doweling_order_name');
    expect(editHeaderSource).toContain('header.doweling_order_name');
    expect(headerSource).toContain('Базис-проект: <Text strong className="order-show-header__compact-text">{compactBasisProjectName}</Text>');
    expect(editHeaderSource).toContain('Базис-проект: <Text strong className="order-show-header__compact-text">{compactBasisProjectName}</Text>');
    expect(headerSource).not.toContain('Присадка: <Text strong');
    expect(editHeaderSource).not.toContain('Присадка: <Text strong');
    expect(headerSource).not.toContain('basisProjects.length > 0 ? `Базис:');
    expect(editHeaderSource).not.toContain('basisProjects.length > 0 ? `Базис:');
    expect(headerSource).not.toContain('collectOrderBasisProjects');
    expect(editHeaderSource).not.toContain('collectOrderBasisProjects');
  });

  it('pins the stack below workspace tabs and keeps table headers below the sticky toolbar', () => {
    const stickyStackStart = showSource.indexOf('ref={orderShowSummaryTabsRef}');
    const toolbarRender = showSource.indexOf('{orderShowDetailsToolbar}', stickyStackStart);
    const infoPanelRender = showSource.indexOf('{activeInfoPanel &&', stickyStackStart);
    const detailsSection = showSource.indexOf('className="order-show-details-section"', stickyStackStart);

    expect(stickyStackStart).toBeGreaterThan(-1);
    expect(toolbarRender).toBeGreaterThan(stickyStackStart);
    expect(toolbarRender).toBeLessThan(infoPanelRender);
    expect(toolbarRender).toBeLessThan(detailsSection);
    expect(appCss).toMatch(/\.order-show-page--sticky-enabled \.order-show-summary-tabs-sticky[\s\S]*position:\s*sticky/);
    expect(appCss).toContain('top: var(--order-show-sticky-top)');
    expect(showSource).toContain('const orderShowDetailTableSticky = useMemo');
    expect(showSource).toContain('sticky={orderShowDetailTableSticky}');
    expect(showSource).toContain('offsetHeader: orderShowTableHeaderTop');
    expect(showSource).toContain('ORDER_SHOW_COMPACT_HEADER_STICKY_HEIGHT');
    expect(showSource).toContain('orderShowTabsShellHeight');
    expect(showSource).toContain('orderShowDetailsToolbarHeight');
    expect(showSource).toContain('orderShowStickyStackMeasured');
    expect(showSource).not.toContain('Math.ceil(workspaceTabsHeight + orderShowSummaryTabsHeight)');
    expect(showSource).not.toContain('orderShowDetailsToolbarNode.getBoundingClientRect().bottom');
    expect(showSource).not.toContain('updateOrderShowTableHeaderTop');
    expect(showSource).not.toContain('workspaceTabsHeight + orderShowSummaryTabsHeight + orderShowDetailsToolbarHeight');
    expect(appCss).toContain('--order-show-compact-header-height: 40px;');
    expect(appCss).toContain('min-height: var(--order-show-compact-header-height);');
    expect(appCss).not.toMatch(/\.order-show-page--sticky-enabled \.order-show-details-toolbar[\s\S]*position:\s*sticky/);
    expect(appCss).not.toMatch(/\.order-show-details-table \.ant-table-thead > tr > th[\s\S]*position:\s*sticky/);
    expect(appCss).not.toContain('order-show-page--table-header-ready');
    expect(appCss).not.toMatch(/\.order-show-page--sticky-enabled \.order-show-details-table \.ant-table-thead > tr > th[\s\S]*position:\s*sticky/);
  });

  it('keeps detail cell component identities stable across sticky state changes', () => {
    expect(showSource).toContain('const ORDER_SHOW_DETAIL_TABLE_COMPONENTS = {');
    expect(showSource).toContain('components={ORDER_SHOW_DETAIL_TABLE_COMPONENTS}');
    expect(showSource).not.toContain('components={{\n                header:');
    expect(showSource).toContain('shouldCellUpdate: (row: any, previousRow: any) => {');
  });

  it('does not reconcile the full detail table when only sticky summary state changes', () => {
    expect(showSource).toContain('function useStableOrderShowColumns');
    expect(showSource).toContain('const MemoizedOrderShowTable = memo(');
    expect(showSource).toContain('<MemoizedOrderShowTable');
    expect(showSource).toContain('renderVersion={orderShowDetailTableRenderVersion}');
    expect(showSource).toContain('columns={stableRenderedDetailColumns}');
    expect(showSource).toContain("order-show-summary-tabs-sticky--stuck");
    expect(showSource).not.toContain("order-show-page--summary-stuck");
    expect(appCss).toContain('.order-show-summary-tabs-sticky--stuck');
  });

  it('uses CSS row hover without Ant Table per-cell mouse handlers', () => {
    expect(showSource).toContain('const OrderShowDetailBodyCell = forwardRef<');
    expect(showSource).toContain('onMouseEnter: _onMouseEnter');
    expect(showSource).toContain('onMouseLeave: _onMouseLeave');
    expect(showSource).toContain('body: { cell: OrderShowDetailBodyCell }');
  });
});
