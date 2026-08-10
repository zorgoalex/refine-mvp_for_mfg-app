import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const app = read('../../App.tsx');
const list = read('./BazisCutListPage.tsx');
const card = read('./BazisCutSetPage.tsx');
const styles = read('./BazisCutSetPage.css');
const modal = read('./AddToBazisCutModal.tsx');
const editDetails = read('../orders/components/tabs/OrderDetailsTab.tsx');
const show = read('../orders/show.tsx');
const desktopSider = read('../../components/CustomSider.tsx');
const mobileSider = read('../../components/MobileSiderDrawer.tsx');

describe('Basis-cut UI integration guards', () => {
  it('registers list/card resource and both routes behind bazisCut', () => {
    expect(app).toMatch(/featureFlags\.bazisCut[\s\S]*name: "bazis-cut-sets"/);
    expect(app).toContain('path="/bazis-cut"');
    expect(app).toContain('path=":id"');
  });

  it('places the resource in Production on desktop and mobile', () => {
    expect(desktopSider).toContain('"bazis-cut-sets": "Производство"');
    expect(mobileSider).toContain('"bazis-cut-sets": "Производство"');
  });

  it('renders the exact requested list columns and source categories', () => {
    for (const label of ['Название набора', 'Дата формирования', 'Заказы / Базис-проекты / Базис-заказы', 'Количество деталей', 'Площадь, м²']) {
      expect(list).toContain(label);
    }
    expect(list).toContain("dataIndex: 'totalAreaM2'");
    expect(list).toContain('ERP-заказы');
    expect(list).toContain('Базис-проекты');
    expect(list).toContain('Базис-заказы');
    expect(list).toContain('OrderDeletedTag');
    expect(card).toContain('sourceOrderDeleted');
    expect(list).toContain('orderDeletedReferenceClassName');
    expect(card).toContain('rowClassName={(row) => orderDeletedReferenceClassName(row.sourceOrderDeleted)}');
    expect(styles).toContain('order-deleted-reference-row');
  });

  it('offers deletion only for empty Basis-cut sets from the list', () => {
    expect(list).toContain("can('cut.manage')");
    expect(list).toContain('bazisCutApi.removeSet(');
    expect(list).toContain('row.positionCount === 0');
    expect(list).toContain('Удалять можно только наборы без деталей');
    expect(list).toContain('Удалить пустой набор?');
    expect(list).toContain('event.stopPropagation()');
  });

  it('supports new/existing searchable set selection', () => {
    expect(modal).toContain('Новый набор');
    expect(modal).toContain('Существующий набор');
    expect(modal).toContain('showSearch');
    expect(modal).toContain('filterOption={false}');
    expect(modal).toContain('БР-<номер набора>');
    expect(modal).not.toContain('Название набора');
  });

  it('wires the action into order edit/show and blocks dirty edit drafts', () => {
    expect(editDetails).toContain('Добавить в Базис раскрой');
    expect(editDetails).toMatch(/icon=\{<TableOutlined \/>}\s*[\s\S]{0,240}aria-label="Добавить в Базис раскрой"/);
    expect(editDetails).toContain('Сначала сохраните изменения заказа');
    expect(editDetails).toContain('const disabled = !bazisCutManage || isDirty');
    expect(editDetails).toContain('disabled={disabled}');
    expect(show).toContain('Добавить в Базис раскрой');
    expect(show).toContain('AddToBazisCutModal');
  });

  it('keeps all 33 fields editable and uses native picker with fallback', () => {
    expect((card.match(/key: '[A-Za-z0-9]+'/g) ?? []).length).toBeGreaterThanOrEqual(33);
    expect(card).toContain("title: 'Базис-проект'");
    expect(card).toContain("dataIndex: 'sourceBazisProjectName'");
    expect(card).toContain("title: 'Базис-заказ'");
    expect(card).toContain("dataIndex: 'sourceBazisOrderNo'");
    expect(card).toContain("title: 'Изделие'");
    expect(card).toContain("dataIndex: 'sourceBazisProductName'");
    expect(card).toContain("title: 'Ванна'");
    expect(card).toContain("dataIndex: 'sourceBathCutNumber'");
    expect(card).not.toContain("field.key === 'position' ||");
    expect(card).toContain('showSaveFilePicker');
    expect(card).toContain('downloadBlob');
    expect(card).toContain("error.name === 'AbortError'");
    expect(card).toContain('label="Общая площадь"');
    expect(card).toContain("row.sourceOrderName || '—'");
    expect(card).not.toContain('row.sourceOrderFullNumber || row.sourceOrderName');
  });

  it('shows the set number with the БР prefix in its workspace tab and keeps detail headers visible', () => {
    expect(card).toContain('`БР #${setId}`');
    expect(card).toContain('sticky={{ offsetHeader: tableHeaderOffset }}');
    expect(card).toContain("document.querySelector<HTMLElement>('.workspace-tabs')");
    expect(card).toContain('new ResizeObserver(update)');
  });

  it('shows numbered scrollable rows, a compact fixed block, and bottom-pinned totals', () => {
    expect(card).toContain("title: '№'");
    expect(card).toContain("title: 'QR-code'");
    expect(card.indexOf("title: 'Позиция'")).toBeLessThan(card.indexOf("title: 'QR-code'"));
    expect(card).toContain('buildBazisCutQrCode(row)');
    const columns = card.slice(card.indexOf('function buildColumns'), card.indexOf('const DetailTableSummary'));
    for (const fixedColumn of [
      "title: '№', key: 'rowNumber', fixed: 'left'",
      "title: 'Источник', key: 'source', fixed: 'left'",
      "title: 'Базис-проект', dataIndex: 'sourceBazisProjectName', key: 'sourceBazisProjectName', fixed: 'left'",
      "title: 'Базис-заказ', dataIndex: 'sourceBazisOrderNo', key: 'sourceBazisOrderNo', fixed: 'left'",
    ]) expect(columns).toContain(fixedColumn);
    expect(columns).toContain("title: 'QR-code', key: 'qrCode', className: QR_CODE_STICKY_CLASS");
    expect((columns.match(/fixed: 'left'/g) ?? [])).toHaveLength(4);
    expect(columns).toContain("title: 'Позиция', dataIndex: 'position', key: 'position', width: 130");
    expect(columns).toContain('buildBazisCutCardPosition(row)');
    expect(columns.indexOf("title: 'Изделие'")).toBeLessThan(columns.indexOf("title: 'Позиция'"));
    expect(columns.indexOf("title: 'Ванна'")).toBeLessThan(columns.indexOf("title: 'Позиция'"));
    expect(columns).toContain("title: 'Наименование', dataIndex: 'partName', key: 'partName', width: 200");
    expect(card).toContain("className={index === QR_CODE_COLUMN_INDEX ? QR_CODE_STICKY_CLASS : undefined}");
    expect(styles).toContain('.bazis-cut-set-details-table.ant-table-wrapper .ant-table-cell.bazis-cut-sticky-qr');
    expect(styles).toContain('left: var(--bazis-cut-sticky-qr-left);');
    expect(card).toContain('scroll={{ x: 5750, y: 480 }}');
    expect(card).toContain('<Table.Summary fixed="bottom">');
    expect(card).toContain('Итого позиций:');
    expect(card).toContain('formatBazisCutAreaM2(setTotals.totalAreaM2)');
  });
});
