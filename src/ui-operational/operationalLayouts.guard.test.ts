import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('LINE/AIR operational layout parity', () => {
  const styles = read('src/ui-operational/operational.css');

  it('keeps the shared LINE/AIR composition layer free of broad transitions', () => {
    expect(styles).not.toMatch(/transition\s*:\s*all\b/);
    expect(styles).toContain(':root:where([data-ui-variant="line"], [data-ui-variant="air"])');
    expect(styles).toContain('--operational-workspace-x: 26px');
    expect(styles).toContain('--operational-workspace-x: 30px');
  });

  it('implements the Bazis table and persistent inspector split', () => {
    const page = read('src/pages/bazis/PanelsTab.tsx');
    expect(page).toContain('className="bazis-panels-workspace"');
    expect(page).toContain('className="bazis-panels-workspace__inspector"');
    expect(page).toContain('aria-label="Поиск панелей"');
    expect(styles).toMatch(/\.bazis-panels-workspace\s*\{[\s\S]*grid-template-columns:/);
    expect(styles).toContain('.bazis-panels-workspace__selection');
  });

  it('implements the calendar period toolbar and horizontal day timeline', () => {
    const board = read('src/pages/calendar/components/CalendarBoard.tsx');
    expect(board).toContain('className="calendar-navigation__operational"');
    expect(board).toContain('value={periodDays}');
    expect(board).toContain("{ label: '2 недели', value: 14 }");
    expect(board).toContain("{ label: 'Месяц', value: 30 }");
    expect(styles).toMatch(/\.calendar-row\s*\{[\s\S]*flex-wrap:\s*nowrap/);
    expect(styles).toMatch(/\.day-column\s*\{[\s\S]*min-width:\s*164px/);
  });

  it('implements standalone cutting list/detail and embedded order split views', () => {
    const cut = read('src/pages/cut/CutPage.tsx');
    expect(cut).toContain("'cut-page-modern--embedded'");
    expect(cut).toContain("'cut-page-modern--detail'");
    expect(cut).toContain('className="cut-jobs-operational-list"');
    expect(styles).toContain('.cut-page-modern--embedded');
    expect(styles).toContain('grid-template-columns: minmax(270px, 320px) minmax(0, 1fr)');
  });

  it('implements the MDF board as a full-height four-column workspace', () => {
    const board = read('src/pages/orderStatusBoard/OrderStatusBoardPage.tsx');
    expect(board).toContain("title={isCncToday ? 'МДФ-работы' : 'Доски статусов'}");
    expect(board).toContain('className="cnc-today-column__load"');
    expect(styles).toMatch(/\.status-board-page\s*\{[\s\S]*height:\s*100%/);
    expect(styles).toContain('.status-board-columns');
  });

  it('implements label view and edit as list, preview, inspector workspaces', () => {
    const viewer = read('src/pages/orders/components/labels/OrderLabelPagesViewer.tsx');
    const editor = read('src/pages/orders/components/labels/OrderLabelDataEditor.tsx');
    expect(viewer).toContain('order-label-pages-viewer--operational');
    expect(viewer).toContain('order-label-pages-viewer__inspector');
    expect(viewer).toContain('grid-template-columns: minmax(190px, 220px) minmax(360px, 1fr) minmax(230px, 280px)');
    expect(viewer).toContain('className="order-label-pages-viewer__print-field"');
    expect(editor).toContain('className="order-label-editor-config"');
    expect(editor).toContain('className="order-label-editor-workspace"');
    expect(editor).toContain('className="order-label-editor-panel order-label-editor-preview"');
    expect(editor).toContain('className="order-label-editor-panel order-label-editor-properties"');
    expect(viewer).toContain("pickValue('detail_name', 'detail.name', 'bazis.name', 'name')");
    expect(viewer).toContain("pickValue('designation', 'article')");
    expect(viewer).toContain("pickValue('material_name', 'material.name', 'material')");
    expect(viewer).toContain("pickValue('film_name', 'film.name', 'film', 'плён')");
  });

  it('keeps the exact nine-tab order composition and removes the legacy Refine header', () => {
    const form = read('src/pages/orders/components/OrderForm.tsx');
    const show = read('src/pages/orders/show.tsx');
    expect(form).toContain(`const operationalOrder = [
        'basic',
        'details',
        'requirements',
        'cut',
        'workshops',
        'finance',
        'dates',
        'additional',
        'services',
      ];`);
    for (const label of ['Обзор', 'Состав', 'Материалы', 'Раскрой', 'Производство', 'Финансы', 'Логистика', 'Бирки', 'Активность']) {
      expect(show).toContain(`label: '${label}'`);
    }
    expect(styles).toContain('.evolution-screen-frame:has(.order-show-page--operational) > div > .ant-page-header');
    expect(styles).toContain('.evolution-screen-frame:has(.order-form-operational) > div > .ant-page-header');
    const pageHeaderRuleStart = styles.indexOf(
      ':root:where([data-ui-variant="line"], [data-ui-variant="air"]) .evolution-screen-frame:has(.order-show-page--operational) > div > .ant-page-header,',
    );
    const pageHeaderRule = styles.slice(pageHeaderRuleStart, styles.indexOf('}', pageHeaderRuleStart));
    expect(pageHeaderRule).toContain('padding: 0');
    expect(pageHeaderRule).not.toContain('display: none');
    expect(styles).toContain('.ant-page-header > :where(.ant-page-header-breadcrumb, .ant-page-header-heading)');
    expect(styles).toContain('.ant-page-header > .ant-page-header-content');
  });

  it('resets fixed desktop navigation offsets on mobile', () => {
    expect(styles).toContain('@media (max-width: 767px)');
    expect(styles).toMatch(/@media \(max-width: 767px\)[\s\S]*\.evolution-shell__main[\s\S]*width:\s*100%/);
    expect(styles).toMatch(/@media \(max-width: 767px\)[\s\S]*\.evolution-shell__main[\s\S]*min-width:\s*0/);
    expect(styles).toMatch(/@media \(max-width: 767px\)[\s\S]*\.evolution-shell__main[\s\S]*margin-left:\s*0/);
  });

  it('maps unmocked list, show, form, and complex workspace routes to operational layouts', () => {
    const layout = read('src/ui-evolution/shell/EvolutionWorkspaceLayout.tsx');
    expect(layout).toContain("pathname.startsWith('/orders/create')");
    expect(layout).toContain("pathname.startsWith('/configuration')");
    expect(layout).toContain("pathname.startsWith('/profile')");
    expect(styles).toContain('[data-operational-page-kind="list"]');
    expect(styles).toContain('[data-operational-page-kind="show"]');
    expect(styles).toContain('[data-operational-page-kind="form"]');
    expect(styles).toContain('.ant-pro-page-container-warp-page-header');
  });
});
