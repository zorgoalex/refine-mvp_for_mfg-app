import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const table = readFileSync(
  fileURLToPath(new URL('./OrderDetailTable.tsx', import.meta.url)),
  'utf8',
);
const show = readFileSync(
  fileURLToPath(new URL('../../show.tsx', import.meta.url)),
  'utf8',
);
const hdfTab = readFileSync(
  fileURLToPath(new URL('../tabs/OrderHdfTab.tsx', import.meta.url)),
  'utf8',
);
const appStyles = readFileSync(
  fileURLToPath(new URL('../../../../styles/app.css', import.meta.url)),
  'utf8',
);

describe('order HDF display guards', () => {
  it('renders calculated HDF rows in the main edit details column', () => {
    expect(table).toContain('details, hdfDetails, updateDetail');
    expect(table).toContain('buildOrderDetailHdfDisplayBySourceDetailId(hdfDetails)');
    expect(table).toContain('detail.source_order_detail_id ?? detail.source_order_detail_id_snapshot');
    expect(table).toContain('<OrderDetailHdfDisplayCell');
    expect(table).toContain('display={getOrderDetailHdfDisplay(hdfDisplayBySourceDetailId, d)}');
    expect(table).toContain('hdfSummaryVersion');
    expect(table).toContain('ХДФ');
    expect(table).toContain(">мм</span>");
    expect(table).not.toContain('order-detail-hdf-cell__qty');
    expect(table).not.toContain('шт.</span>');
    expect(table).toContain("too_narrow: 'Узкая деталь'");
  });

  it('renders calculated HDF rows in the order show details column', () => {
    expect(show).toContain('buildOrderShowHdfDisplayBySourceDetailId(hdfDetails)');
    expect(show).toContain('const hdfDetailBySourceDetailId = useMemo');
    expect(show).toContain('renderOrderShowHdfCell(');
    expect(show).toContain('getOrderShowHdfDisplay(hdfDetailBySourceDetailId, detail)');
    expect(show).toContain('ORDER_DETAIL_SHOW_HDF_COLUMN_WIDTH');
    expect(show).toContain("too_narrow: 'Узкая деталь'");
  });

  it('keeps the HDF tab compact and includes original source dimensions', () => {
    expect(hdfTab).toContain('className="order-hdf-table"');
    expect(hdfTab).toContain('tableLayout="fixed"');
    expect(hdfTab).not.toContain('scroll={{ x:');
    expect(hdfTab).toContain("dataIndex: 'source_height_mm'");
    expect(hdfTab).toContain("dataIndex: 'source_width_mm'");
    expect(hdfTab).toContain("dataIndex: 'source_quantity'");
    expect(hdfTab).toContain("hdfHeader('Исх.', 'выс.')");
    expect(hdfTab).toContain("hdfHeader('Исх.', 'шир.')");
    expect(hdfTab).toContain("hdfHeader('Исх.', 'кол.')");
    expect(hdfTab).toContain("hdfHeader('Раскрой')");
    expect(hdfTab).toContain("hdfHeader('Базис', 'раскрой')");
    expect(hdfTab).toContain('hdfDetailIds={selectedHdfDetailIds}');
    expect(hdfTab).toContain('припуск 0,5 мм/стор.');
    expect(appStyles).toContain('.order-hdf-table__header');
    expect(appStyles).toContain('text-wrap: balance');
    expect(appStyles).toContain('.order-hdf-table__number');
    expect(appStyles).toContain('.order-hdf-table__link');
    expect(appStyles).toContain('.order-detail-hdf-cell__size');
  });
});
