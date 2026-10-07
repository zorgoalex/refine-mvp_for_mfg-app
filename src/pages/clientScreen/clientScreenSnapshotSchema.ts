import { z } from 'zod';
import { CLIENT_SCREEN_CODES } from './clientScreenRegistry';

/**
 * What travels from the manager window to the customer window. Everything is display-ready text:
 * no ids of the order, no source objects. Row and group ids are opaque random strings issued by the
 * manager window for one presentation. The schema is strict on purpose: a message that carries
 * anything else is dropped by the customer window.
 */
export const CLIENT_SCREEN_TAB_KEYS = ['basic', 'details', 'hdf', 'dates', 'finance', 'services'] as const;
export type ClientScreenTabKey = typeof CLIENT_SCREEN_TAB_KEYS[number];

const code = z.enum(CLIENT_SCREEN_CODES);
const text = z.string().max(2000);
const label = z.string().max(200);
const opaqueId = z.string().regex(/^[a-z0-9]{6,32}$/);

const field = z.object({ code, label, value: text }).strict();

const table = z.object({
  columns: z.array(z.object({ code, label, align: z.enum(['left', 'right']) }).strict()).max(40),
  /** cells[i] belongs to columns[i]. */
  rows: z.array(z.object({ id: opaqueId, cells: z.array(text).max(40) }).strict()).max(5000),
  /** Present only when the manager groups the rows by a field the customer may see. */
  groups: z.array(z.object({ id: opaqueId, title: text, rowIds: z.array(opaqueId).max(5000) }).strict()).max(2000).optional(),
}).strict().refine((value) => value.rows.every((row) => row.cells.length === value.columns.length), {
  message: 'row width differs from the columns',
});

export const clientScreenSnapshotSchema = z.object({
  title: label,
  summary: z.array(field).max(40),
  tabs: z.array(z.object({ key: z.enum(CLIENT_SCREEN_TAB_KEYS), label, counter: z.string().max(20).optional() }).strict()).max(20),
  basic: z.array(field).max(40).optional(),
  dates: z.array(field).max(40).optional(),
  /** The HDF tab: its order-level values and the table of calculated HDF details. */
  hdf: z.object({ fields: z.array(field).max(40), table: table.optional() }).strict().optional(),
  finance: z.object({ fields: z.array(field).max(40), payments: table.optional() }).strict().optional(),
  details: table.optional(),
  services: table.optional(),
}).strict();

export const clientScreenUiSchema = z.object({
  /** The tab the customer sees: the manager's tab, or the last visible one when the manager is on a hidden tab. */
  tab: z.enum(CLIENT_SCREEN_TAB_KEYS).nullable(),
  focus: z.object({ code, rowId: opaqueId.optional() }).strict().nullable(),
  /** Values of the row the manager is editing right now, before they reach the saved draft. */
  editing: z.object({ rowId: opaqueId, values: z.array(z.object({ code, value: text }).strict()).max(40) }).strict().nullable(),
  scroll: z.object({ ratio: z.number().min(0).max(1), anchorRowId: opaqueId.optional() }).strict().nullable(),
  /**
   * The manager's page of the detail table. `start`/`count` give the exact run of the customer's rows
   * that are on that page (the manager's page may also hold empty grid rows the customer never gets).
   */
  page: z.object({
    current: z.number().int().min(1).max(100000), size: z.number().int().min(1).max(1000),
    start: z.number().int().min(0).max(5000).optional(), count: z.number().int().min(0).max(1000).optional(),
  }).strict().nullable(),
}).strict();

export type ClientScreenSnapshot = z.infer<typeof clientScreenSnapshotSchema>;
export type ClientScreenUi = z.infer<typeof clientScreenUiSchema>;
export type ClientScreenField = z.infer<typeof field>;
export type ClientScreenTable = z.infer<typeof table>;
