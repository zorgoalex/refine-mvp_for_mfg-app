import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const calendarList = readFileSync(join(__dirname, 'index.tsx'), 'utf8');
const board = readFileSync(join(__dirname, 'components/CalendarBoard.tsx'), 'utf8');
const dataHook = readFileSync(join(__dirname, 'hooks/useCalendarData.ts'), 'utf8');

describe('calendar filters integration', () => {
  it('keeps one top quick filter for order/client and passes filters to the board', () => {
    expect(calendarList).toContain('const [filters, setFilters] = useState<CalendarFilters>({})');
    expect(calendarList).toContain('getCalendarActiveFilterCount(filters)');
    expect(calendarList).toContain('filters={filters}');
    expect(calendarList).toContain('onFiltersChange={setFilters}');
    expect(calendarList).toContain('className="calendar-page-header"');
    expect(calendarList).toContain('filtersOpen={filtersOpen}');
    expect(calendarList).not.toContain('filtersOpen={isOperational && filtersOpen}');
    expect(calendarList).not.toContain('Запланировать заказ');
    expect(calendarList).not.toContain("navigate('/orders/create')");
    expect(calendarList).not.toContain('PlusOutlined');
    expect(board).toContain('placeholder="Заказ / клиент"');
    expect(board).toContain('quickSearch');
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
});
