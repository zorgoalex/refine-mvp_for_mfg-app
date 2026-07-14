import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text guards for the boolean "Присадка" (doweling) detail field:
// the field must stay wired through schema/mapper/dataProvider and the three
// UI surfaces (detail modal, bulk edit, context-menu selection) plus PDF import.

const orderTypes = readFileSync(new URL('../../types/orders.ts', import.meta.url), 'utf8');
const orderSchema = readFileSync(new URL('../../schemas/orderSchema.ts', import.meta.url), 'utf8');
const orderMapper = readFileSync(new URL('../../api/mappers/orderMapper.ts', import.meta.url), 'utf8');
const dataProvider = readFileSync(new URL('../../utils/dataProvider.ts', import.meta.url), 'utf8');
const detailModal = readFileSync(
  new URL('./components/modals/OrderDetailModal.tsx', import.meta.url),
  'utf8',
);
const bulkEditModal = readFileSync(
  new URL('./components/modals/BulkEditModal.tsx', import.meta.url),
  'utf8',
);
const detailTable = readFileSync(
  new URL('./components/tables/OrderDetailTable.tsx', import.meta.url),
  'utf8',
);
const pdfImportModal = readFileSync(
  new URL('./components/import/PdfImportModal.tsx', import.meta.url),
  'utf8',
);
const pdfExtractor = readFileSync(
  new URL('./components/import/utils/pdfTextExtractor.ts', import.meta.url),
  'utf8',
);

describe('order detail doweling field guards', () => {
  it('is declared across type/schema/mapper layers', () => {
    expect(orderTypes).toContain('doweling?: boolean;');
    expect(orderSchema).toContain('doweling: z.boolean().optional()');
    // Save direction (snake → camel) and read direction (camel → snake).
    expect(orderMapper).toContain('doweling: detail.doweling === true');
    expect(orderMapper).toContain('doweling: detail.doweling === true,');
  });

  it('is whitelisted in the legacy Hasura jsonb key lists', () => {
    const matches = dataProvider.match(/"doweling"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('detail modal exposes the Присадка checkbox', () => {
    expect(detailModal).toMatch(/name="doweling" valuePropName="checked"/);
    expect(detailModal).toContain('<Checkbox>Присадка</Checkbox>');
  });

  it('bulk edit supports set AND clear semantics', () => {
    expect(bulkEditModal).toContain('doweling: boolean;');
    expect(bulkEditModal).toMatch(/if \(enabledFields\.doweling\) \{/);
    expect(bulkEditModal).toContain('changes.doweling = values.doweling === true;');
  });

  it('detail table has the column and the context-menu selection by doweling', () => {
    expect(detailTable).toContain("{ key: 'doweling', label: 'Присадка' }");
    expect(detailTable).toContain("key: 'select:category:doweling', label: 'по присадке'");
    expect(detailTable).toMatch(/select:doweling:true[\s\S]*?selectRows\(d => d\.doweling === true\)/);
    // Inline edit must seed the form value, otherwise saving a row would drop the flag.
    expect(detailTable).toContain('doweling: record.doweling === true,');
  });

  it('detail grouping supports «по присадке» and toolbar has selection reset', () => {
    const grouping = readFileSync(new URL('./detailGrouping.ts', import.meta.url), 'utf8');
    const detailsTab = readFileSync(
      new URL('./components/tabs/OrderDetailsTab.tsx', import.meta.url),
      'utf8',
    );
    const showPage = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
    expect(grouping).toContain("{ field: 'doweling', label: 'по присадке' }");
    expect(grouping).toMatch(/case 'doweling': return detail\.doweling === true \? 'yes' : EMPTY_GROUP_KEY;/);
    // Оба groupLabelOf (edit-таблица и show) обязаны знать поле.
    expect(detailTable).toContain("case 'doweling': return sample.doweling === true ? 'Присадка' : '—';");
    expect(showPage).toContain("case 'doweling': return sample.doweling === true ? 'Присадка' : '—';");
    // Кнопка сброса любого выделения (чекбоксы + pending drag).
    expect(detailsTab).toContain('Сбросить выделение');
    expect(detailsTab).toMatch(/handleClearSelection[\s\S]*?dragSelectionState\?\.cancel\(\);[\s\S]*?setSelectedRowKeys\(\[\]\)/);
  });

  it('PDF import auto-sets doweling from the note', () => {
    expect(pdfExtractor).toMatch(/doweling: \/присадка\/i\.test\(detail\.note \?\? ''\)/);
    expect(pdfImportModal).toContain('doweling: row.doweling === true,');
  });
});
