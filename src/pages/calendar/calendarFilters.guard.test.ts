import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const calendarList = readFileSync(join(__dirname, 'index.tsx'), 'utf8');
const board = readFileSync(join(__dirname, 'components/CalendarBoard.tsx'), 'utf8');
const dataHook = readFileSync(join(__dirname, 'hooks/useCalendarData.ts'), 'utf8');
const mobileStyles = readFileSync(join(__dirname, 'styles/calendar-mobile.css'), 'utf8');
const tabletStyles = readFileSync(join(__dirname, '../../ui-evolution/styles/tablet.css'), 'utf8');

describe('calendar filters integration', () => {
  it('keeps one top quick filter for order/client and passes filters to the board', () => {
    expect(calendarList).toContain('const [filters, setFilters] = useState<CalendarFilters>({})');
    expect(calendarList).toContain('getCalendarActiveFilterCount(filters)');
    expect(calendarList).toContain('filters={filters}');
    expect(calendarList).toContain('onFiltersChange={setFilters}');
    expect(calendarList).toContain('className="calendar-page-header"');
    expect(calendarList).toContain('filtersOpen={filtersOpen}');
    expect(calendarList).toContain('activeFilterCount={activeFilterCount}');
    expect(calendarList).toContain('onFiltersToggle={() => setFiltersOpen((open) => !open)}');
    expect(calendarList).not.toContain('filtersOpen={isOperational && filtersOpen}');
    expect(calendarList).not.toContain('Запланировать заказ');
    expect(calendarList).not.toContain("navigate('/orders/create')");
    expect(calendarList).not.toContain('PlusOutlined');
    expect(board).toContain('placeholder="Заказ / клиент"');
    expect(board).toContain('quickSearch');
  });

  it('uses workspace scrolling and one immediately compact icon-only sticky calendar bar on tablets', () => {
    const tabletCalendarGridRule = tabletStyles.match(/\.evolution-shell--tablet \.calendar-grid \{[^}]*\}/)?.[0] ?? '';

    expect(board).toContain('className="calendar-navigation__tablet-filter"');
    expect(board).toContain('className="calendar-navigation__mode-text"');
    expect(tabletStyles).toMatch(/\.evolution-shell--tablet \.calendar-page-wrapper \{[\s\S]*height: auto;[\s\S]*overflow: visible !important;/);
    expect(tabletStyles).toMatch(/\.evolution-shell__content\.ant-layout-content\.calendar-page-active \{[\s\S]*overflow-x: auto !important;[\s\S]*overflow-y: auto !important;[\s\S]*-webkit-overflow-scrolling: touch;[\s\S]*touch-action: pan-x pan-y;/);
    expect(tabletCalendarGridRule).toContain('height: auto;');
    expect(tabletCalendarGridRule).toContain('max-height: none;');
    expect(tabletCalendarGridRule).toContain('overflow: visible;');
    expect(tabletCalendarGridRule).not.toContain('overflow-x');
    expect(tabletCalendarGridRule).not.toContain('overflow-y');
    expect(tabletStyles).toMatch(/data-modern-route="calendar"[^}]+\.calendar-navigation \{[\s\S]*position: sticky;[\s\S]*height: var\(--tablet-sticky-row\);/);
    expect(tabletStyles).toContain('.calendar-navigation__tablet-filter');
    expect(tabletStyles).toContain('.calendar-navigation__mode-text');
    expect(calendarList).toContain('const { workspaceActive } = useKeepAlive()');
    expect(calendarList).toContain('if (content && workspaceActive)');
  });

  it('collapses every phone calendar control under one disclosure and hides the page title', () => {
    expect(board).toContain('const MobileCalendarDisclosure');
    expect(board).toContain('mobile={isMobile}');
    expect(board).toContain('aria-controls="calendar-mobile-controls"');
    expect(board).toContain('Настройки календаря');
    expect(board).toContain("filtersOpen ? 'Скрыть фильтры' : 'Фильтры'");
    expect(mobileStyles).toContain('.calendar-page-wrapper > .operational-page-head');
    expect(mobileStyles).toContain('.calendar-page-wrapper > .calendar-page-header');
    expect(mobileStyles).toContain('.calendar-mobile-disclosure__toggle');
    expect(mobileStyles).toContain('min-height: 44px');
    expect(mobileStyles).toContain('grid-template-rows: 0fr');
    expect(mobileStyles).toContain('transition-property: grid-template-rows, opacity, visibility');
    expect(mobileStyles).not.toContain('transition: all');
  });

  it('renders separate filter block fields requested for calendar', () => {
    expect(board).toContain('className="calendar-filters-panel"');
    expect(board).toContain('name="orderQuery"');
    expect(board).toContain('name="clientQuery"');
    expect(board).toContain('name="materialName"');
    expect(board).toContain('name="millingTypeName"');
    expect(board).toContain('name="paymentStatusName"');
    expect(board).toContain('name="orderStatusName"');
    expect(board).toContain('Применить');
    expect(board).toContain('Сбросить');
  });

  it('applies filters after order details are enriched', () => {
    expect(dataHook).toContain('applyCalendarFilters(ordersWithDetails, filters)');
    expect(dataHook).toContain('materialOptions');
    expect(dataHook).toContain('millingTypeOptions');
  });

  it('sources material filter options only from sheet material reference', () => {
    expect(dataHook).toContain("resource: 'sheet_material_types'");
    expect(dataHook).toContain("meta: { fields: ['sheet_material_type_id', 'name', 'sort_order', 'is_active'] }");
    expect(dataHook).toMatch(/const materialOptions = useMemo\(\(\) => \{[\s\S]*sheetMaterialTypesData\?\.data[\s\S]*sheetMaterialType\?\.name[\s\S]*\}, \[sheetMaterialTypesData\?\.data\]\)/);
    expect(dataHook).not.toMatch(/const materialOptions = useMemo\(\(\) => \{[\s\S]*material\?\.material_name[\s\S]*\}, \[[^\]]*materialsData\?\.data/);
    expect(dataHook).not.toMatch(/const materialOptions = useMemo\(\(\) => \{[\s\S]*detail\?\.material_name[\s\S]*\}, \[[^\]]*detailNamesData\?\.data/);
  });

  it('loads only active doweling links for calendar order cards', () => {
    const dowelingLinksQuery = dataHook.split("resource: 'order_doweling_links'")[1]?.split('pagination')[0] ?? '';

    expect(dowelingLinksQuery).toContain("field: 'delete_flag'");
    expect(dowelingLinksQuery).toContain("operator: 'eq'");
    expect(dowelingLinksQuery).toContain('value: false');
  });
});
