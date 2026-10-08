import type { ClientScreenField, ClientScreenSnapshot, ClientScreenTabKey, ClientScreenTable, ClientScreenUi } from './clientScreenSnapshotSchema';

/**
 * What the customer window draws: the snapshot with the interface state applied — the active tab,
 * the field or cell the manager is on, the values of the row being edited, the manager's page of
 * the detail table. Pure, so the drawing component has no decisions of its own.
 */
export interface MirrorField extends ClientScreenField {
  focused: boolean;
}

export interface MirrorTable {
  columns: ClientScreenTable['columns'];
  rows: Array<{ id: string; focused: boolean; editing: boolean; cells: Array<{ text: string; focused: boolean; edited: boolean }> }>;
  /** Group titles keyed by the id of the first row of each group. */
  groupTitleBefore: Record<string, string>;
}

export interface MirrorView {
  title: string;
  summary: ClientScreenField[];
  tabs: Array<{ key: ClientScreenTabKey; label: string; counter?: string; active: boolean }>;
  activeTab: ClientScreenTabKey | null;
  fields: MirrorField[];
  table: MirrorTable | null;
  /** The finance tab has both fields and the payments table. */
  tableTitle: string | null;
  /** Further tables of the tab, each under its title (the «Материалы» tab has two tables). */
  moreTables: Array<{ title: string; table: MirrorTable }>;
}

function mirrorTable(table: ClientScreenTable, ui: ClientScreenUi | null, options: { editable: boolean; paged: boolean }): MirrorTable {
  const focus = ui?.focus ?? null;
  const editing = options.editable ? ui?.editing ?? null : null;
  const edited = new Map<string, string>((editing?.values ?? []).map((item) => [item.code, item.value]));
  const groups = table.groups ?? [];
  let rows = table.rows;
  if (groups.length) {
    // Rows follow the manager's groups; a row outside every group keeps its place at the end.
    const byId = new Map(table.rows.map((row) => [row.id, row]));
    const grouped = groups.flatMap((group) => group.rowIds.map((id) => byId.get(id)).filter((row): row is ClientScreenTable['rows'][number] => Boolean(row)));
    const inGroups = new Set(grouped.map((row) => row.id));
    rows = [...grouped, ...table.rows.filter((row) => !inGroups.has(row.id))];
  } else if (options.paged && ui?.page && ui.page.start !== undefined && ui.page.count !== undefined) {
    // Exactly the rows of the manager's page, even when none of them is the customer's to see.
    rows = table.rows.slice(ui.page.start, ui.page.start + ui.page.count);
  } else if (options.paged && ui?.page) {
    const start = (ui.page.current - 1) * ui.page.size;
    const page = table.rows.slice(start, start + ui.page.size);
    // A page number that no longer exists (rows were removed) falls back to all rows.
    if (page.length) rows = page;
  }
  const groupTitleBefore: Record<string, string> = {};
  for (const group of groups) if (group.rowIds.length) groupTitleBefore[group.rowIds[0]] = group.title;
  return {
    columns: table.columns,
    groupTitleBefore,
    rows: rows.map((row) => {
      const isEditing = editing?.rowId === row.id;
      const rowFocused = focus?.rowId === row.id;
      // Several columns may share a code (the payments list): then the whole row is marked, not a cell.
      const focusColumn = rowFocused ? table.columns.findIndex((column) => column.code === focus?.code) : -1;
      const single = focusColumn >= 0 && table.columns.filter((column) => column.code === focus?.code).length === 1;
      return {
        id: row.id,
        focused: rowFocused,
        editing: isEditing,
        cells: row.cells.map((text, index) => {
          const code = table.columns[index].code;
          const value = isEditing && edited.has(code) ? edited.get(code)! : text;
          return { text: value, focused: single && index === focusColumn, edited: isEditing && edited.has(code) && edited.get(code) !== text };
        }),
      };
    }),
  };
}

export function buildMirrorView(snapshot: ClientScreenSnapshot, ui: ClientScreenUi | null): MirrorView {
  const keys = snapshot.tabs.map((tab) => tab.key);
  const activeTab = ui?.tab && keys.includes(ui.tab) ? ui.tab : keys[0] ?? null;
  const focusCode = ui?.focus && ui.focus.rowId === undefined ? ui.focus.code : null;
  const withFocus = (fields: ClientScreenField[] | undefined): MirrorField[] => (fields ?? []).map((field) => ({ ...field, focused: field.code === focusCode }));

  let fields: MirrorField[] = [];
  let table: MirrorTable | null = null;
  let tableTitle: string | null = null;
  const moreTables: Array<{ title: string; table: MirrorTable }> = [];
  if (activeTab === 'basic') fields = withFocus(snapshot.basic);
  else if (activeTab === 'dates') fields = withFocus(snapshot.dates);
  else if (activeTab === 'hdf') {
    fields = withFocus(snapshot.hdf?.fields);
    if (snapshot.hdf?.table) table = mirrorTable(snapshot.hdf.table, ui, { editable: false, paged: false });
  } else if (activeTab === 'finance') {
    fields = withFocus(snapshot.finance?.fields);
    if (snapshot.finance?.payments) {
      table = mirrorTable(snapshot.finance.payments, ui, { editable: false, paged: false });
      tableTitle = 'Оплаты';
    }
  } else if (activeTab === 'details' && snapshot.details) table = mirrorTable(snapshot.details, ui, { editable: true, paged: true });
  else if (activeTab === 'services' && snapshot.services) table = mirrorTable(snapshot.services, ui, { editable: false, paged: false });
  else if (activeTab === 'requirements') {
    const plain = { editable: false, paged: false };
    if (snapshot.requirements?.films) {
      table = mirrorTable(snapshot.requirements.films, ui, plain);
      tableTitle = 'Пленка';
      if (snapshot.requirements.sheets) moreTables.push({ title: 'Листовые материалы', table: mirrorTable(snapshot.requirements.sheets, ui, plain) });
    } else if (snapshot.requirements?.sheets) {
      table = mirrorTable(snapshot.requirements.sheets, ui, plain);
      tableTitle = 'Листовые материалы';
    }
  }

  return {
    title: snapshot.title,
    summary: snapshot.summary,
    tabs: snapshot.tabs.map((tab) => ({ ...tab, active: tab.key === activeTab })),
    activeTab,
    fields,
    table,
    tableTitle,
    moreTables,
  };
}
