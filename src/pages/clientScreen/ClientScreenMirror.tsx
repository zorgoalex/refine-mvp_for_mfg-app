import React from 'react';
import type { MirrorTable, MirrorView } from './mirrorView';

/**
 * The order as the customer sees it, drawn from a ready view. Pure drawing: the customer window
 * uses it for the screen itself, the manager window for the small preview of that screen.
 */
const Table: React.FC<{ table: MirrorTable }> = ({ table }) => (
  <div className="client-screen__table-wrap">
    <table className="client-screen__table">
      <thead>
        <tr>
          {table.columns.map((column, index) => (
            <th key={`${column.code}:${index}`} scope="col" className={column.align === 'right' ? 'client-screen__num' : undefined}>{column.label}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.length === 0 ? (
          <tr><td className="client-screen__empty" colSpan={Math.max(1, table.columns.length)}>Пока пусто</td></tr>
        ) : table.rows.map((row) => (
          <React.Fragment key={row.id}>
            {table.groupTitleBefore[row.id] !== undefined ? (
              <tr className="client-screen__group"><td colSpan={Math.max(1, table.columns.length)}>{table.groupTitleBefore[row.id]}</td></tr>
            ) : null}
            <tr data-row-id={row.id} className={row.focused || row.editing ? 'client-screen__row--focused' : undefined}>
              {row.cells.map((cell, index) => (
                <td
                  key={index}
                  data-focused={cell.focused ? 'true' : undefined}
                  className={[
                    table.columns[index].align === 'right' ? 'client-screen__num' : '',
                    cell.focused ? 'client-screen__cell--focused' : '',
                    cell.edited ? 'client-screen__cell--edited' : '',
                  ].filter(Boolean).join(' ') || undefined}
                >
                  {cell.text}
                </td>
              ))}
            </tr>
          </React.Fragment>
        ))}
      </tbody>
    </table>
  </div>
);

export const ClientScreenMirror: React.FC<{ view: MirrorView; bodyRef?: React.Ref<HTMLDivElement> }> = ({ view, bodyRef }) => (
    <div className="client-screen__order">
      <div className="client-screen__head">
        <h1 className="client-screen__title">{view.title}</h1>
        {view.summary.length ? (
          <div className="client-screen__chips">
            {view.summary.map((field) => (
              <span key={field.code} className="client-screen__chip">{field.label}: <b>{field.value}</b></span>
            ))}
          </div>
        ) : null}
        <div className="client-screen__tabs" role="tablist" aria-label="Вкладки заказа">
          {view.tabs.map((tab) => (
            <span key={tab.key} role="tab" aria-selected={tab.active} className={`client-screen__tab${tab.active ? ' client-screen__tab--active' : ''}`}>
              {tab.label}{tab.counter !== undefined ? ` (${tab.counter})` : ''}
            </span>
          ))}
        </div>
      </div>
      <div className="client-screen__body" ref={bodyRef}>
        {view.fields.length ? (
          <div className="client-screen__fields">
            {view.fields.map((field) => (
              <div key={field.code} className={`client-screen__field${field.focused ? ' client-screen__field--focused' : ''}`}>
                <span className="client-screen__label">{field.label}</span>
                <span className="client-screen__value">{field.value}</span>
              </div>
            ))}
          </div>
        ) : null}
        {view.table ? (
          <>
            {view.tableTitle ? <h2 className="client-screen__subtitle">{view.tableTitle}</h2> : null}
            <Table table={view.table} />
          </>
        ) : null}
      </div>
    </div>
);
