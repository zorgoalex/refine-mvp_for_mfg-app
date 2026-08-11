import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const sourcePath = resolve(__dirname, 'OrderDetailTable.tsx');
const source = readFileSync(sourcePath, 'utf8');

describe('OrderDetailTable reference cells', () => {
  it('keeps table reference cells pure and map-backed', () => {
    expect(source).toContain('const MaterialCell: React.FC');
    expect(source).toContain('namesById: Map<number, string>');
    expect(source).toContain('resolveReferenceLabel(materialId, namesById)');
    expect(source).toContain('resolveReferenceLabel(millingTypeId, namesById)');
    expect(source).toContain('resolveReferenceLabel(edgeTypeId, namesById)');
    expect(source).toContain('resolveReferenceLabel(filmId, namesById)');
    expect(source).toContain('resolveReferenceLabel(statusId, namesById)');
  });

  it('does not call useOne inside reference cell component bodies', () => {
    const cellBlock = source.slice(source.indexOf('const MaterialCell: React.FC'));
    expect(cellBlock).not.toMatch(/useOne\s*\(/);
  });

  it('keeps fixed numeric columns readable at the right scroll edge', () => {
    expect(source).toContain("key: 'doweling',\n      width: 64");
    expect(source).toContain(
      "key: 'milling_cost_per_sqm',\n      width: ORDER_DETAIL_COLUMN_WIDTHS.millingCostPerSqm",
    );
    expect(source).toContain("fontSize: 11, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'");
    expect(source).toContain('scroll={{ x: tableScrollWidth, y: 500 }}');
  });

  it('uses integer-first editors for every editable numeric detail cell', () => {
    expect(source.match(/<CurrencyInput/g)).toHaveLength(6);
    expect(source).not.toContain('formatter={currencySmartFormatter}');
    expect(source).toContain('precision={0}\n              onChange={handleQuantityChange}');
    expect(source).toContain('precision={0}\n              min={1}\n              max={999}');
  });

  it('keeps the detail production status column compact in the order card table', () => {
    const columnStart = source.indexOf("title: <div style={{ textAlign: 'center', fontSize: '75%' }}>Статус</div>");
    const columnEnd = source.indexOf("key: 'basis_project'", columnStart);
    const statusColumn = source.slice(columnStart, columnEnd);

    expect(statusColumn).toContain('width: 60');
    expect(statusColumn).toContain("align: 'center'");
    expect(source).toContain('const ORDER_DETAIL_TABLE_STATUS_BADGE_STYLE');
    expect(source).toContain('fontSize: 10');
    expect(source).toContain("overflowWrap: 'anywhere'");
    expect(source).not.toContain('return <Tag color="blue">');
  });
});
